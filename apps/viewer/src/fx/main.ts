// Effect preview: plays exported EFP programs (work/out/fx, `pnpm tsx packages/convert/src/tools/export-fx.ts`)
// with @sro/fx, optionally attached to the converted chinaman character's bones.
// Query string (all optional):
//   fx=<key>            effect to start with (Particles path, e.g. skill/china/cold_ganggi_keep_a.efp)
//   bone=<name>         attach bone (e.g. Bip01 R Hand); empty = world origin
//   all=1               list every exported effect instead of the Chinese skills
//   engine=webgl        force WebGL2 (default: WebGPU when available)
import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateLineSystem,
  HemisphericLight,
  LoadAssetContainerAsync,
  Scene,
  Vector3,
  type AnimationGroup,
  type AssetContainer,
  type TransformNode,
} from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { FxInstance, FxLibrary, nodePose, type FxEffect, type FxRootPose } from '@sro/fx'
import { createEngine } from '../engine.ts'

const OUT = '/out/'
const CHARACTER = 'char/china/chinaman_adventurer.glb'

interface IndexFile {
  effects: Array<{ key: string; url: string; nodes: number; duration: number | null; skills: string[]; warnings: string[] }>
  failures: Array<{ key: string; error: string }>
}
interface SkillStage {
  phase: string
  startEvent: number
  actType: string
  move: string
  effect: string | null
  startBone: string | null
  effect2: string | null
}
interface SkillsFile {
  masteries: Array<{ id: number; name: string }>
  skills: Array<{
    group: string
    mastery: number
    name: string | null
    masteryLevel: number
    defense: string | null
    damage: string | null
    arrowTail: string | null
    arrowForce: string | null
    stages: SkillStage[]
  }>
}
interface Entry {
  key: string
  label: string
  bone: string | null
  note: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const params = new URLSearchParams(location.search)

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (run: pnpm tsx packages/convert/src/tools/export-fx.ts)`)
  return (await res.json()) as T
}

const { engine, kind, canvas, note } = await createEngine($('canvas'), params.get('engine') !== 'webgl')
$('engine-badge').textContent = kind
if (note) $('engine-badge').title = note

const scene = new Scene(engine)
scene.useRightHandedSystem = true
scene.clearColor = new Color4(0.09, 0.094, 0.11, 1)
const camera = new ArcRotateCamera('camera', Math.PI / 2 + 0.6, 1.2, 5, new Vector3(0, 1, 0), scene)
camera.wheelDeltaPercentage = 0.02
camera.minZ = 0.01
camera.maxZ = 1000
camera.attachControl(canvas, true)
const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
hemi.intensity = 0.9
hemi.groundColor = new Color3(0.25, 0.25, 0.28)
{
  const lines: Vector3[][] = []
  const colors: Color4[][] = []
  for (let i = -10; i <= 10; i++) {
    const c = i === 0 ? new Color4(0.45, 0.47, 0.52, 1) : new Color4(0.25, 0.26, 0.29, 1)
    lines.push([new Vector3(i, 0, -10), new Vector3(i, 0, 10)], [new Vector3(-10, 0, i), new Vector3(10, 0, i)])
    colors.push([c, c], [c, c])
  }
  CreateLineSystem('grid', { lines, colors }, scene).isPickable = false
}

const library = new FxLibrary(scene, OUT)
const [index, skills] = await Promise.all([json<IndexFile>(`${OUT}fx/index.json`), json<SkillsFile>(`${OUT}fx/skills.json`)])
const known = new Set(index.effects.map(e => e.key))

function skillEntries(): Entry[] {
  const out: Entry[] = []
  const mastery = new Map(skills.masteries.map(m => [m.id, m.name]))
  for (const s of skills.skills) {
    const title = `${mastery.get(s.mastery) ?? s.mastery} | ${s.name ?? s.group} (M${s.masteryLevel})`
    const add = (key: string | null, what: string, bone: string | null) => {
      if (!key || out.some(e => e.key === key && e.label.startsWith(title))) return
      out.push({ key, label: `${title}: ${what}`, bone, note: `${s.group}\n${what}` })
    }
    for (const st of s.stages) {
      add(st.effect, `${st.phase} ${st.actType}${st.startBone ? ' @' + st.startBone : ''}`, st.startBone)
      add(st.effect2, `${st.phase} target`, null)
    }
    add(s.damage, 'damage', null)
    add(s.defense, 'defense', null)
    add(s.arrowTail, 'arrow tail', null)
    add(s.arrowForce, 'arrow force', null)
  }
  return out
}

function allEntries(): Entry[] {
  return index.effects.map(e => ({
    key: e.key,
    label: e.key,
    bone: null,
    note: `${e.nodes} nodes, ${e.duration === null ? 'loops' : (e.duration / 20).toFixed(2) + ' s'}${e.skills.length ? '\nskills: ' + e.skills.join(', ') : ''}${e.warnings.length ? '\n' + e.warnings.join('\n') : ''}`,
  }))
}

let entries: Entry[] = []
const listMode = $<HTMLSelectElement>('list-mode')
const filter = $<HTMLInputElement>('filter')
const list = $<HTMLSelectElement>('effects')
listMode.value = params.get('all') === '1' ? 'all' : 'skills'

function refreshList(select?: string): void {
  entries = listMode.value === 'all' ? allEntries() : skillEntries()
  const q = filter.value.trim().toLowerCase()
  list.replaceChildren()
  entries.forEach((e, i) => {
    if (q && !e.label.toLowerCase().includes(q) && !e.key.includes(q)) return
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = e.label + (known.has(e.key) ? '' : ' (missing)')
    o.title = e.key
    list.append(o)
    if (select && e.key === select && list.selectedIndex < 0) o.selected = true
  })
}
listMode.addEventListener('change', () => refreshList())
filter.addEventListener('input', () => refreshList())

// Character.
let character: AssetContainer | null = null
let clips: AnimationGroup[] = []
const clipSelect = $<HTMLSelectElement>('clip')
try {
  character = await LoadAssetContainerAsync(OUT + CHARACTER, scene, {
    pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
  })
  character.addAllToScene()
  clips = character.animationGroups
  for (const g of clips) {
    const o = document.createElement('option')
    o.value = g.name
    o.textContent = g.name
    clipSelect.append(o)
  }
  clipSelect.value = clips.find(g => g.name === 'STAND1') ? 'STAND1' : (clips[0]?.name ?? '')
} catch (err) {
  $('effect-info').textContent = `character not loaded: ${(err as Error).message}`
}

function playClip(): void {
  for (const g of clips) g.stop()
  clips.find(g => g.name === clipSelect.value)?.start(true)
}
clipSelect.addEventListener('change', playClip)
playClip()

function boneNode(name: string): TransformNode | null {
  if (!character || !name) return null
  for (const s of character.skeletons) for (const b of s.bones) if (b.getTransformNode()?.name === name) return b.getTransformNode()
  return character.transformNodes.find(t => t.name === name) ?? null
}

const showChar = $<HTMLInputElement>('show-char')
showChar.addEventListener('change', () => {
  for (const m of character?.meshes ?? []) m.setEnabled(showChar.checked)
})

// Playback.
let current: FxInstance | null = null
let currentEffect: FxEffect | null = null
const boneSelect = $<HTMLSelectElement>('bone')
const rotationSelect = $<HTMLSelectElement>('rotation')
const loop = $<HTMLInputElement>('loop')
const speed = $<HTMLSelectElement>('speed')
const scaleInput = $<HTMLInputElement>('scale')

function pose(): () => FxRootPose {
  const bone = boneNode(boneSelect.value)
  if (!bone) return () => ({ position: [0, 0, 0] })
  return nodePose(bone, rotationSelect.value === 'bone' ? bone : null)
}

async function play(): Promise<void> {
  const e = entries[Number(list.value)]
  if (!e) return
  current?.dispose()
  current = null
  try {
    currentEffect = await library.load(e.key)
  } catch (err) {
    $('effect-info').textContent = `${e.key}: ${(err as Error).message}`
    return
  }
  const eff = currentEffect
  current = new FxInstance(library, eff, { pose: pose(), loop: loop.checked, scale: Number(scaleInput.value) || 1 })
  const info = index.effects.find(x => x.key === e.key)
  $('effect-info').textContent =
    `${e.key}\n${e.note}\n${eff.nodes.length} nodes, root scale ${eff.scale}, ${eff.duration === null ? 'loops forever' : (eff.duration / 20).toFixed(2) + ' s'}` +
    (eff.warnings.length ? `\nwarnings: ${eff.warnings.join('; ')}` : '') +
    (info ? '' : '\n(not in index)')
  const url = new URL(location.href)
  url.searchParams.set('fx', e.key)
  url.searchParams.set('bone', boneSelect.value)
  history.replaceState(null, '', url)
}

list.addEventListener('change', () => {
  const e = entries[Number(list.value)]
  if (e?.bone && [...boneSelect.options].some(o => o.value === e.bone)) boneSelect.value = e.bone
  void play()
})
$('play').addEventListener('click', () => void play())
$('stop').addEventListener('click', () => current?.stop())
for (const el of [boneSelect, rotationSelect, loop, scaleInput]) el.addEventListener('change', () => void play())

boneSelect.value = params.get('bone') ?? 'Bip01 R Hand'
const startKey = params.get('fx') ?? 'skill/china/cold_ganggi_keep_a.efp'
if (listMode.value === 'skills' && !skillEntries().some(e => e.key === startKey)) listMode.value = 'all'
refreshList(startKey)
if (list.selectedIndex >= 0) void play()

// Frame loop and stats.
const stats = $('stats')
let frames = 0
let fpsT = performance.now()
let fps = 0
engine.runRenderLoop(() => {
  const dt = (engine.getDeltaTime() / 1000) * Number(speed.value)
  current?.update(dt)
  scene.render()
  frames++
  const now = performance.now()
  if (now - fpsT > 500) {
    fps = (frames * 1000) / (now - fpsT)
    frames = 0
    fpsT = now
    const s = current?.stats
    stats.textContent = s
      ? `${fps.toFixed(0)} fps  ${kind}\n` +
        `tick ${s.ticks} (${(s.ticks / 20).toFixed(2)} s)\n` +
        `elements ${s.elements} (drawing nodes ${s.visible})\n` +
        `particles drawn ${s.drawn}, batches ${s.batches}\n` +
        (s.finished ? 'finished' : '')
      : `${fps.toFixed(0)} fps  ${kind}`
  }
})
addEventListener('resize', () => engine.resize())

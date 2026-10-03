// World viewer: renders a converted region set (work/out/world/<name>/manifest.json, `pnpm sro convert-region`)
// through @sro/world-render (the same renderer the game uses), plus a demo player and debug overlays.
// Query string (all optional):
//   world=jangan        output folder under /out/world/
//   assets=out          asset root under the site ('out', or 'out-opt' for the slimmed tree when it is served)
//   engine=webgl        force WebGL2 (default: WebGPU when available)
//   time=0..1           time of day (0 midnight, 0.5 noon; default 0.5)
//   env=<id>            force an environment profile (default: the block under the player)
//   objects=0           skip objects; animated=0 skips only the skinned (animated) ones
//   lod=0               disable the draw-distance culling (TERRAIN.md 6.3)
//   lm=0|1|2            object lightmap off / 1x / 2x (default 1)
//   terrain=0..4        terrain view: textured, layer count, lightmap only, first layer only, tile ids
//   quality=low|medium|high  draw-distance preset (default medium = the native ranges)
//   spawn=<x>,<z>[,<y>] player spawn in glTF metres, snapped to the nav surface nearest y (default: the highest);
//                       default manifest.spawn, else the centre of the origin region
//   playerScale=0.8..1.3 uniform character Height factor (default 1.06, docs/CHARACTER_SCALE.md)
//   fly=1               start in free-fly; nav=1, borders=1, wire=1 start with those overlays on
//   stream=0|1          region streaming (docs/FIELDS.md §3): 1 streams (an export without a stream block is split in
//                       memory), 0 loads the whole world; default: stream when the export has a stream block. While
//                       streaming, the focus is the player (orbit) or the camera (fly), and the debug overlays cover
//                       the regions loaded when the page opened
// Wave 9 render lab (render-panel.ts has the full list): preset=low|medium|high|ultra, render=classic|pbr,
//   sky=modern|classic, weather=<state>[:intensity], wxlevel=, clock=fast|<minutes per day>, tonemap=, lut=, exposure=,
//   ssao=1, taaReproj=1, fix=sheen,prepass, gpuLimits=default. Without any of them the viewer is the Classic viewer
//   it was.
// Wave 12 trees lab (trees-panel.ts): trees=new|retail (the tree mode at load), bands=1 (the band view).
import {
  PointerEventTypes,
  Scene,
  SceneInstrumentation,
  Vector3,
  WebGPUEngine,
  type AbstractEngine,
  type Mesh,
} from '@babylonjs/core'
import {
  Assets,
  Minimap,
  attachNightLights,
  errorText,
  formatTime,
  installRenderPost,
  loadWorld,
  spawnAt,
  surfaceLabel,
  type LightmapMode,
  type NightLights,
  type WorldLoadProgress,
  type WorldQuality,
} from '@sro/world-render'
import { createEngine } from '../engine.ts'
import { CameraRig } from './cameras.ts'
import { Overlays } from './overlays.ts'
import { Player } from './player.ts'
import { BatchPanel } from './batch-panel.ts'
import { GrassPanel, parseGrassParams } from './grass-panel.ts'
import { RenderPanel, applyLabShaderFixes, parseLabParams, resolveLab } from './render-panel.ts'
import { TownPanel } from './town-panel.ts'
import { TreesPanel, parseTreesParams } from './trees-panel.ts'

const PLAYER_ID = 'char/china/chinaman_adventurer'
const PLAYER_FALLBACK = { glb: 'char/china/chinaman_adventurer.glb', sidecar: 'char/china/chinaman_adventurer.json' }
/** Camera follow height above the feet at scale 1 (m); scaled with the player like the native 20 units x Height. */
const EYE_HEIGHT = 1.4
/**
 * Default character Height factor. docs/CHARACTER_SCALE.md: the native Height choices are 0.94 + 0.03 h (h = 0..4,
 * default 2 = 1.00); 1.06 (h = 4) is its recommendation for this demo player, consistent with the original-client
 * screenshot estimate (1.07 +- 0.05) and with the user's report that he looks a bit short. Compare with ?playerScale=1.
 */
const DEFAULT_PLAYER_SCALE = 1.06
const PLAYER_SCALE_MIN = 0.8
const PLAYER_SCALE_MAX = 1.3
/** Standing-pose height of chinaman_adventurer at scale 1 (docs/CHARACTER_SCALE.md). */
const PLAYER_HEIGHT_M = 1.821

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`#${id} missing from world.html`)
  return node as T
}

const ui = {
  canvas: el<HTMLCanvasElement>('canvas'),
  stats: el<HTMLDivElement>('stats'),
  minimap: el<HTMLCanvasElement>('minimap'),
  status: el<HTMLDivElement>('status'),
  badge: el<HTMLSpanElement>('engine-badge'),
  time: el<HTMLInputElement>('time'),
  timeOut: el<HTMLOutputElement>('time-out'),
  envInfo: el<HTMLDivElement>('env-info'),
  wire: el<HTMLInputElement>('t-wire'),
  nav: el<HTMLInputElement>('t-nav'),
  borders: el<HTMLInputElement>('t-borders'),
  lightmap: el<HTMLInputElement>('t-lightmap'),
  statics: el<HTMLInputElement>('t-static'),
  animated: el<HTMLInputElement>('t-animated'),
  water: el<HTMLInputElement>('t-water'),
  fog: el<HTMLInputElement>('t-fog'),
  sky: el<HTMLInputElement>('t-sky'),
  lod: el<HTMLInputElement>('t-lod'),
  minimapOn: el<HTMLInputElement>('t-minimap'),
  objLm: el<HTMLSelectElement>('obj-lm'),
  terrainView: el<HTMLSelectElement>('terrain-view'),
  renderPanel: el<HTMLElement>('render-panel'),
}

const params = new URLSearchParams(location.search)
const flag = (name: string, dflt: boolean): boolean => {
  const v = params.get(name)
  return v === null ? dflt : !(v === '0' || v === 'false' || v === 'off')
}

let statusTimer = 0
function setStatus(text: string, kind: 'info' | 'error' = 'info', ms = 0): void {
  ui.status.textContent = text
  ui.status.className = text ? `show ${kind}` : ''
  window.clearTimeout(statusTimer)
  if (text && ms > 0) statusTimer = window.setTimeout(() => setStatus(''), ms)
}

/**
 * Babylon compiles GLSL on WebGPU only through glslang + twgsl, which it downloads from its CDN. Every shader here is
 * WGSL on WebGPU, so a GLSL pipeline means a regression: block it (no network) and report it in the HUD.
 */
const glslBlocked: string[] = []
function guardGlslOnWebGPU(engine: AbstractEngine): void {
  if (!(engine instanceof WebGPUEngine)) return
  type Prepare = (ctx: { shaderProcessingContext?: { shaderLanguage?: number } }, ...rest: unknown[]) => Promise<void>
  const e = engine as unknown as { _preparePipelineContextAsync: Prepare }
  const orig = e._preparePipelineContextAsync.bind(engine)
  e._preparePipelineContextAsync = (ctx, ...rest) => {
    if (ctx.shaderProcessingContext?.shaderLanguage === 0) {
      const key = String(rest[8] ?? '?').split('\n')[0]!.slice(0, 80)
      glslBlocked.push(key)
      console.error(`[world] GLSL shader reached the WebGPU engine and was blocked (would download glslang/twgsl): ${key}`)
      return new Promise<void>(() => {})
    }
    return orig(ctx, ...rest)
  }
}

const STAGE_TEXT: Record<WorldLoadProgress['stage'], string> = {
  manifest: 'Manifest', regions: 'Regions', navigation: 'Navigation', tiles: 'Terrain tiles', terrain: 'Building terrain',
  water: 'Water', objects: 'Objects', done: 'Done',
}

async function main(): Promise<void> {
  const t0 = performance.now()
  const worldName = params.get('world') || 'jangan'
  const assetRoot = (params.get('assets') || 'out').replace(/[^a-z0-9_-]/gi, '')
  const outBase = new URL(`${assetRoot}/`, document.baseURI)
  const outAssets = new Assets(outBase)

  const { engine, kind, canvas, note, gpu } = await createEngine(ui.canvas, params.get('engine') !== 'webgl')
  ui.badge.textContent = kind
  ui.badge.title = note ?? `${kind} engine`
  guardGlslOnWebGPU(engine)
  window.addEventListener('resize', () => engine.resize())

  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  scene.skipPointerMovePicking = true
  scene.skipPointerDownPicking = true
  const instr = new SceneInstrumentation(scene)

  const legacyQuality = (['low', 'medium', 'high'] as const).find(q => q === params.get('quality')) ?? 'medium'
  // Wave 9 lab (render-panel.ts): ?preset= and friends; without them this is the old Classic viewer.
  const lab = resolveLab(parseLabParams(location.search), legacyQuality)
  // GL-O's grass lab (grass-panel.ts): ?grass=retail|field, ?tufts=1, ?tiers=1.
  const grassLab = parseGrassParams(location.search)
  // T12-L's trees lab (trees-panel.ts): ?trees=new|retail, ?bands=1.
  const treesLab = parseTreesParams(location.search)
  const quality = lab.quality
  const lmParam = Number(params.get('lm') ?? 1)
  const envParam = params.get('env')
  const time = Math.min(0.999, Math.max(0, Number(params.get('time') ?? 0.5) || 0))
  const streamParam = params.get('stream')
  const stream = streamParam === null ? 'auto' as const : flag('stream', false)
  // ?fix=sheen: the lab's patch for Babylon 9.28's sheen + clustered-light shader bug (render-panel.ts).
  const fixes = await applyLabShaderFixes(lab.fixes)
  if (fixes.length) console.info('[world] lab shader fixes:', fixes.join(', '))
  setStatus(`Loading /${assetRoot}/world/${worldName}/manifest.json`)
  const world = await loadWorld(scene, {
    baseUrl: outBase,
    world: worldName,
    timeOfDay: time,
    quality: quality as WorldQuality,
    objects: flag('objects', true),
    animated: flag('animated', true),
    lightmapMode: (lmParam === 0 || lmParam === 2 ? lmParam : 1) as LightmapMode,
    terrainView: Math.max(0, Math.min(4, Number(params.get('terrain') ?? 0) || 0)),
    fog: flag('fog', true),
    terrainLightmap: flag('lightmap', true),
    envProfile: envParam !== null ? Number(envParam) : null,
    waitForObjects: false,
    stream,
    render: lab.renderPath,
    sky: lab.skyStyle,
    weatherLevel: lab.resolvedLevel,
    ...(grassLab.style ? { grassStyle: grassLab.style } : {}),
    hideRetailTufts: !grassLab.tufts,
    ...(treesLab.mode ? { trees: treesLab.mode } : {}),
    gpu,
    onProgress: p => setStatus(p.total > 1 ? `${STAGE_TEXT[p.stage]} ${p.done}/${p.total}` : STAGE_TEXT[p.stage]),
  })
  // Post options that need their own stack (SSAO, TAA reprojection, D30): replace the default one before its first build.
  if (world.render.mode === 'pbr' && (lab.ssao || lab.taaReprojection)) {
    installRenderPost(world.render, { ssao: lab.ssao, taaReprojection: lab.taaReprojection })
  }
  const { manifest, nav, materials, objects } = world
  for (const w of world.warnings) console.warn('[world]', w)
  const navWarning = world.warnings.find(w => w.startsWith('nav:'))
  if (navWarning) setStatus(navWarning, 'error', 8000)
  else if (world.warnings.length) setStatus(`${world.warnings.length} load warning(s), see console`, 'error', 8000)
  ui.time.value = String(world.timeOfDay)
  ui.timeOut.textContent = formatTime(world.timeOfDay)
  ui.terrainView.value = String(Math.max(0, Math.min(4, Number(params.get('terrain') ?? 0) || 0)))
  ui.objLm.value = String(materials.lightmapMode)

  // Spawn: ?spawn=x,z[,y] > the world's spawn (manifest.spawn located on the nav surface).
  const spawnParam = params.get('spawn')?.split(',').map(Number)
  const spawn = spawnParam && (spawnParam.length === 2 || spawnParam.length === 3) && spawnParam.every(Number.isFinite)
    ? spawnAt(nav, spawnParam[0]!, spawnParam[1]!, spawnParam[2] ?? Infinity)
    : world.spawn
  const scaleParam = Number(params.get('playerScale'))
  let playerScale = params.has('playerScale') && Number.isFinite(scaleParam)
    ? Math.min(PLAYER_SCALE_MAX, Math.max(PLAYER_SCALE_MIN, scaleParam))
    : DEFAULT_PLAYER_SCALE

  const overlays = new Overlays(scene, world.regions)
  overlays.buildNavmesh()
  overlays.buildObjectNav(nav)
  overlays.buildBorders()
  // loadWorld already loads the minimap tiles (world.minimap); draw them into the HUD canvas.
  let minimap = world.minimap
  let minimapLoad: Promise<void> = Promise.resolve()
  if (minimap) minimap.attach(ui.minimap)
  else minimapLoad = (minimap = new Minimap(ui.minimap, manifest)).load(world.assets)

  const player = new Player(scene, nav, spawn, playerScale)
  const rig = new CameraRig(scene, canvas, world, player.position.add(new Vector3(0, EYE_HEIGHT * playerScale, 0)))
  if (flag('fly', false)) rig.toggle()
  // The lab lights the night like the game (fx-world.ts attaches the same module on every preset).
  let nightLights: NightLights | null = null
  if (lab.active) {
    try {
      nightLights = attachNightLights(world, { focus: () => player.position })
    } catch (err) {
      console.warn('[world] night lights:', err)
    }
  }

  // Player (converted model, /out/index.json entry).
  const playerLoad = (async () => {
    let entry = PLAYER_FALLBACK
    try {
      const index = await outAssets.json<Array<{ id: string; glb: string; sidecar?: string }>>('index.json')
      const e = index.find(i => i.id === PLAYER_ID)
      if (e) entry = { glb: e.glb, sidecar: e.sidecar ?? PLAYER_FALLBACK.sidecar }
    } catch (err) {
      console.warn('[world] index.json:', err)
    }
    await player.load(outAssets, materials, entry.glb, entry.sidecar)
    // PBR presets: the player casts and receives the renderer's shadows (a no-op part on the Classic path).
    for (const m of player.node.getChildMeshes()) world.render.addCharacter(m)
  })().catch(err => {
    player.error = errorText(err)
    console.warn('[world] player:', err)
  })

  objects.setLod(flag('lod', true))
  ui.lod.checked = flag('lod', true)

  // ---- UI --------------------------------------------------------------------------------------------------------

  // The render lab (world.html #render-panel): idle until used, so the Classic viewer stays as it was.
  const panel = new RenderPanel(ui.renderPanel, {
    engine,
    scene,
    world,
    gpu,
    kind,
    pause: () => engine.stopRenderLoop(renderLoop),
    resume: () => engine.runRenderLoop(renderLoop),
    camera: () => scene.activeCamera,
    benchView: () => {
      // bench.ts's town view: the orbit camera at the player, fixed angles, 14 m out.
      if (rig.mode === 'fly') rig.toggle()
      rig.orbit.alpha = -Math.PI / 2
      rig.orbit.beta = 1.2
      rig.orbit.radius = 14
    },
  }, lab)
  new GrassPanel(ui.renderPanel, world, grassLab)
  const treesPanel = new TreesPanel(ui.renderPanel, world, treesLab)
  // The batching lab (batch-panel.ts, BT-L): a section of the render panel; the toggle, counters, A/B and bench spots.
  const batchPanel = new BatchPanel(ui.renderPanel, {
    engine,
    scene,
    world,
    controls: panel,
    pause: () => engine.stopRenderLoop(renderLoop),
    resume: () => engine.runRenderLoop(renderLoop),
    draws: () => instr.drawCallsCounter.current,
    goto: (x, z, alpha, beta, radius) => {
      player.teleport(x, z)
      if (rig.mode === 'fly') rig.toggle()
      rig.orbit.alpha = alpha
      rig.orbit.beta = beta
      rig.orbit.radius = radius
    },
  })

  // The town lab (town-panel.ts, TL-L): counts, roles, the clock scrub, the rebuild toggle, the A/B and LAB-11's scenes.
  const townPanel = new TownPanel(ui.renderPanel, {
    engine,
    scene,
    world,
    controls: panel,
    pause: () => engine.stopRenderLoop(renderLoop),
    resume: () => engine.runRenderLoop(renderLoop),
    draws: () => instr.drawCallsCounter.current,
    goto: (x, z, alpha, beta, radius) => {
      player.teleport(x, z)
      if (rig.mode === 'fly') rig.toggle()
      rig.orbit.alpha = alpha
      rig.orbit.beta = beta
      rig.orbit.radius = radius
    },
  })

  const bind = (input: HTMLInputElement, fn: (on: boolean) => void, initial?: boolean): void => {
    if (initial !== undefined) input.checked = initial
    input.addEventListener('change', () => fn(input.checked))
    fn(input.checked)
  }
  bind(ui.wire, on => { scene.forceWireframe = on }, flag('wire', false))
  bind(ui.nav, on => overlays.setNavmeshVisible(on), flag('nav', false))
  bind(ui.borders, on => overlays.setBordersVisible(on), flag('borders', false))
  bind(ui.lightmap, on => world.setTerrainLightmap(on), flag('lightmap', true))
  bind(ui.statics, on => objects.setStaticVisible(on))
  bind(ui.animated, on => objects.setAnimatedVisible(on))
  bind(ui.water, on => world.water.setVisible(on))
  bind(ui.fog, on => world.setFog(on), flag('fog', true))
  // SkySystem.setVisible, not sky.mesh: before the modern dome exists `mesh` is the retail dome (W9F TEX-5).
  bind(ui.sky, on => world.sky.setVisible(on))
  bind(ui.lod, on => objects.setLod(on))
  bind(ui.minimapOn, on => { ui.minimap.style.display = on ? '' : 'none' })
  ui.objLm.addEventListener('change', () => materials.setLightmapMode(Number(ui.objLm.value) as LightmapMode))
  ui.terrainView.addEventListener('change', () => world.setTerrainView(Number(ui.terrainView.value)))
  ui.time.addEventListener('input', () => {
    // Scrubbing freezes the time (a running lab clock stops; the lab's Clock row restarts it).
    if (world.worldClock) panel.setClockMinutes(null)
    world.setTimeOfDay(Number(ui.time.value))
    ui.timeOut.textContent = formatTime(world.timeOfDay)
  })
  window.addEventListener('keydown', e => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code === 'KeyF') rig.toggle()
    else if (e.code === 'KeyH') document.body.classList.toggle('hide-panels')
  })

  // Player Height slider (world.html has no slot for it: added to the controls panel here).
  {
    const section = document.createElement('section')
    section.innerHTML = '<h2>Player</h2><label class="row" title="Uniform character Height factor (docs/CHARACTER_SCALE.md: ' +
      'native choices 0.94 / 0.97 / 1.00 / 1.03 / 1.06)">Height <input id="player-scale" type="range" min="' +
      `${PLAYER_SCALE_MIN}" max="${PLAYER_SCALE_MAX}" step="0.01" /><output id="player-scale-out"></output></label>`
    const help = document.querySelector('#controls section.help')
    if (help?.parentElement) help.parentElement.insertBefore(section, help)
    else document.getElementById('controls')?.appendChild(section)
    const input = section.querySelector<HTMLInputElement>('#player-scale')!
    const out = section.querySelector<HTMLOutputElement>('#player-scale-out')!
    const show = (): void => {
      out.textContent = `${playerScale.toFixed(2)} · ${(PLAYER_HEIGHT_M * playerScale).toFixed(2)} m`
    }
    input.value = String(playerScale)
    show()
    input.addEventListener('input', () => {
      playerScale = Number(input.value)
      player.setScale(playerScale)
      show()
      const url = new URL(location.href)
      url.searchParams.set('playerScale', playerScale.toFixed(2))
      history.replaceState(null, '', url)
    })
  }

  // Click-to-move: a click (not a drag) picks the walkable surface under the cursor (object floors included, so the
  // plaza is hit where it is drawn, not at the hidden terrain below it; the terrain meshes are the fallback).
  let down: { x: number; y: number; t: number } | null = null
  scene.onPointerObservable.add(pi => {
    const ev = pi.event as PointerEvent
    if (pi.type === PointerEventTypes.POINTERDOWN && ev.button === 0) {
      down = { x: ev.clientX, y: ev.clientY, t: performance.now() }
    } else if (pi.type === PointerEventTypes.POINTERUP && ev.button === 0 && down) {
      const click = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 6 && performance.now() - down.t < 500
      down = null
      const cam = scene.activeCamera
      if (!click || !cam) return
      const hit = world.pick(scene.createPickingRay(scene.pointerX, scene.pointerY, null, cam))
      if (hit) player.moveTo(hit.point)
    }
  })

  // ---- render loop -----------------------------------------------------------------------------------------------

  let loadMs = 0
  const follow = new Vector3()
  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(0.1, engine.getDeltaTime() / 1000)
    player.update(dt)
    follow.copyFrom(player.position)
    follow.y += EYE_HEIGHT * playerScale
    rig.update(follow)
    // PBR: the post stack follows the camera the rig renders with (F switches orbit / fly).
    const cam = scene.activeCamera
    if (cam && world.render.mode === 'pbr' && world.render.activeCamera !== cam) world.render.attachCamera(cam)
    // Streaming focus: the player, or the camera itself while flying (so flying around loads the land under it).
    world.update(scene.activeCamera, rig.mode === 'fly' && world.stream ? undefined : player.position)
  })

  let statsTimer = 0
  const lastMoveLine = (): string => {
    const r = player.lastMove
    if (!r) return ''
    const h = r.hit
    const what = !r.blocked ? 'arrived' : h?.kind === 'edge'
      ? `blocked by ${h.outline ? 'outline' : 'inline'} edge ${h.edge} flag ${h.flag}` +
        (h.instance !== undefined ? ` of ${nav.world.instanceInfo(h.instance).model.split('/').pop()}` : '')
      : `blocked (${h?.kind ?? '?'})`
    return `move      ${r.distance.toFixed(1)} m, ${r.legs.length} leg(s), ${what}`
  }
  const renderStats = (): void => {
    const active = scene.getActiveMeshes()
    let tris = 0
    let thin = 0
    for (let i = 0; i < active.length; i++) {
      const m = active.data[i] as Mesh
      const n = m.hasThinInstances ? m.thinInstanceCount : 1
      if (m.hasThinInstances) thin += n
      tris += ((m.getTotalIndices() || m.getTotalVertices()) / 3) * n
    }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    const st = world.stream?.stats
    const vis = objects.visibleCounts
    const s = objects.stats
    const loc = world.regions.locate(player.position.x, player.position.z)
    const blk = world.blockAt(player.position.x, player.position.z)
    const mb = (world.assets.bytes + outAssets.bytes) / 1048576
    const profile = world.envProfile
    const fog = world.fogRange
    ui.envInfo.textContent = profile
      ? `profile ${profile.id} "${profile.name}"${world.envForced ? ' (forced)' : ''} · fog ${fog.start.toFixed(0)}–${fog.end.toFixed(0)} m`
      : 'no environment profile (defaults)'
    const lines = [
      `engine    ${kind}${note ? ' *' : ''} · /${assetRoot}/`,
      `fps       ${engine.getFps().toFixed(0)}`,
      `draws     ${instr.drawCallsCounter.current}`,
      `meshes    ${active.length} active / ${scene.meshes.length}`,
      `thin inst ${thin} active / ${s.thinInstances} (${s.instanceMeshes} meshes, ${vis.chunks}/${s.chunks} chunks)`,
      `clones    ${vis.clones}/${s.clones} animated (${objects.animatingCount} running)`,
      `triangles ${(tris / 1e6).toFixed(2)} M`,
      `heap      ${mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a'}`,
      `load      ${loadMs ? (loadMs / 1000).toFixed(1) + ' s' : 'loading…'}`,
      `download  ${mb.toFixed(1)} MB (${world.assets.files + outAssets.files} files)`,
      `models    ${s.models} ok, ${s.failed} failed · lightmaps ${materials.lightmapCount}`,
      st ? `stream    ${st.ready}/${st.wanted} ready (${st.resident} resident, ${st.objectsReady} with objects) · ` +
        `${st.fetching} fetching · ${st.jobs} jobs · ${(st.bytes / 1048576).toFixed(1)} MB` : 'stream    off (whole world)',
      st ? `          models ${st.modelsLoaded} (${st.modelsCached} cached) · tiles ${st.tileLayersUsed}/${st.tileLayers} · ` +
        `frame ${st.lastFrameMs.toFixed(1)} ms (worst ${st.worstFrameMs.toFixed(1)}) · ${st.unloads} unloaded` : '',
      `camera    ${rig.mode} · player ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(1)} × ${playerScale.toFixed(2)}`,
      `nav       ${world.navSource === 'manifest' ? `${nav.world.instanceCount} objects` : 'terrain only (fallback)'} · on ${surfaceLabel(nav, player.navPosition.surface)}`,
      lastMoveLine(),
      loc ? `region    ${loc.data.region.x},${loc.data.region.z} (0x${loc.data.region.id.toString(16)}) block ${blk ? `${blk.block.bx},${blk.block.bz} env ${blk.block.environmentId}` : '-'}` : 'region    (outside)',
    ]
    let html = lines.filter(Boolean).map(escapeHtml).join('\n')
    if (player.error) html += `\n<span class="warn">player: ${escapeHtml(player.error)}</span>`
    if (glslBlocked.length) html += `\n<span class="warn">GLSL on WebGPU blocked: ${glslBlocked.length} (see console)</span>`
    if (objects.errors.length) html += `\n<span class="warn">${objects.errors.length} model(s) failed (see console)</span>`
    ui.stats.innerHTML = html
  }

  const renderLoop = (): void => {
    scene.render()
    statsTimer += engine.getDeltaTime()
    if (statsTimer > 500) {
      statsTimer = 0
      renderStats()
      // A running clock moves the time: keep the slider on it.
      if (world.worldClock) {
        ui.time.value = String(world.timeOfDay)
        ui.timeOut.textContent = formatTime(world.timeOfDay)
      }
    }
    if (ui.minimapOn.checked) {
      const cam = scene.activeCamera
      const fwd = cam ? cam.getForwardRay(1).direction : new Vector3(0, 0, -1)
      const cp = cam?.globalPosition ?? player.position
      minimap?.draw({ x: player.position.x, z: player.position.z, heading: player.heading }, { x: cp.x, z: cp.z, tx: cp.x + fwd.x, tz: cp.z + fwd.z })
    }
  }
  engine.runRenderLoop(renderLoop)

  await Promise.all([playerLoad, world.objectsReady, minimapLoad])
  loadMs = performance.now() - t0
  const failed = objects.errors.length
  setStatus(`Loaded ${manifest.name}: ${world.stream ? `${world.stream.stats.ready}/${manifest.regions.length} regions streamed` : `${manifest.regions.length} regions`}, ${objects.stats.models} models, ` +
    `${objects.stats.thinInstances} thin instances, ${objects.stats.clones} animated in ${(loadMs / 1000).toFixed(1)} s` +
    (failed ? ` · ${failed} model(s) failed` : ''), failed ? 'error' : 'info', 6000)
  Object.assign(window, { sroWorld: { scene, engine, world, nav, terrain: world.terrain, water: world.water, objects, player, rig, materials, overlays, manifest, lab: panel, batch: batchPanel, town: townPanel, trees: treesPanel, nightLights } })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

main().catch(err => {
  console.error(err)
  setStatus(errorText(err), 'error')
})

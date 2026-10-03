/**
 * Placeholder 3D backdrops for the outer screens (login, server select, character select/create).
 * The original client flies a camera over a real map region (see README "Login / character-select backdrop");
 * that needs the world renderer, so for now this is a simple lantern-lit plaza built from primitives.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateCylinder,
  CreateDisc,
  CreateGround,
  CreatePlane,
  CreateSphere,
  CreateTorus,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  Mesh,
  PointLight,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
  type AbstractEngine,
} from '@babylonjs/core'

export function newScene(engine: AbstractEngine, clear = new Color4(0.05, 0.05, 0.07, 1)): Scene {
  const scene = new Scene(engine)
  // glTF is right-handed; keeping the scene right-handed leaves every node transform exactly as stored.
  scene.useRightHandedSystem = true
  scene.clearColor = clear
  scene.ambientColor = new Color3(0.25, 0.25, 0.25)
  return scene
}

function stoneTexture(scene: Scene, name: string, tiles: number, base: string, line: string): DynamicTexture {
  const size = 512
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  const cell = size / tiles
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      const v = 0.85 + ((x * 7 + y * 13) % 5) * 0.05
      ctx.fillStyle = `rgba(0,0,0,${(1 - v).toFixed(2)})`
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }
  ctx.strokeStyle = line
  ctx.lineWidth = 3
  for (let i = 0; i <= tiles; i++) {
    ctx.beginPath()
    ctx.moveTo(i * cell, 0)
    ctx.lineTo(i * cell, size)
    ctx.moveTo(0, i * cell)
    ctx.lineTo(size, i * cell)
    ctx.stroke()
  }
  tex.update()
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

function mat(scene: Scene, name: string, diffuse: Color3, emissive = Color3.Black()): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.diffuseColor = diffuse
  m.emissiveColor = emissive
  m.specularColor = new Color3(0.08, 0.08, 0.08)
  return m
}

export interface Plaza {
  scene: Scene
  camera: ArcRotateCamera
  /** Top of the central platform (y). */
  floorY: number
  /** The fill and the key (moon) light (the character screen's studio environment follows them). */
  hemi: HemisphericLight
  key: DirectionalLight
}

/** Dusk plaza: tiled ground, raised round platform, a ring of red lacquered columns with lanterns. */
export function buildPlaza(engine: AbstractEngine): Plaza {
  const scene = newScene(engine, new Color4(0.09, 0.1, 0.16, 1))
  scene.fogMode = Scene.FOGMODE_EXP2
  scene.fogDensity = 0.018
  scene.fogColor = new Color3(0.09, 0.1, 0.16)

  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  hemi.intensity = 0.55
  hemi.diffuse = new Color3(0.75, 0.78, 0.95)
  hemi.groundColor = new Color3(0.2, 0.16, 0.12)
  const moon = new DirectionalLight('moon', new Vector3(0.4, -1, -0.6).normalize(), scene)
  moon.intensity = 0.7
  moon.diffuse = new Color3(0.8, 0.82, 1)

  const ground = CreateGround('ground', { width: 240, height: 240 }, scene)
  const groundMat = mat(scene, 'groundMat', new Color3(0.55, 0.52, 0.47))
  const gt = stoneTexture(scene, 'groundTex', 8, '#8a8174', '#3d372f')
  gt.uScale = gt.vScale = 30
  groundMat.diffuseTexture = gt
  ground.material = groundMat
  ground.isPickable = false

  const floorY = 0.4
  const platform = CreateCylinder('platform', { diameter: 14, height: floorY, tessellation: 64 }, scene)
  platform.position.y = floorY / 2
  const platMat = mat(scene, 'platMat', new Color3(0.62, 0.58, 0.52))
  const pt = stoneTexture(scene, 'platTex', 6, '#9c9384', '#4a4238')
  pt.uScale = pt.vScale = 4
  platMat.diffuseTexture = pt
  platform.material = platMat
  platform.isPickable = false
  const rim = CreateTorus('rim', { diameter: 14, thickness: 0.18, tessellation: 64 }, scene)
  rim.position.y = floorY
  rim.material = mat(scene, 'rimMat', new Color3(0.55, 0.42, 0.18), new Color3(0.12, 0.08, 0.02))
  rim.isPickable = false

  const column = mat(scene, 'columnMat', new Color3(0.55, 0.08, 0.06))
  const gold = mat(scene, 'goldMat', new Color3(0.7, 0.55, 0.2), new Color3(0.15, 0.1, 0.02))
  const paper = mat(scene, 'lanternMat', new Color3(1, 0.5, 0.2), new Color3(1, 0.45, 0.15))
  // Columns on the far half-circle (-Z); cameras look from +Z.
  const n = 9
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI
    const r = 11
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const c = CreateCylinder(`col${i}`, { diameter: 0.7, height: 6, tessellation: 16 }, scene)
    c.position.set(x, 3, z)
    c.material = column
    c.isPickable = false
    const cap = CreateCylinder(`cap${i}`, { diameter: 1.1, height: 0.35, tessellation: 16 }, scene)
    cap.position.set(x, 6.1, z)
    cap.material = gold
    cap.isPickable = false
    const lantern = CreateSphere(`lantern${i}`, { diameter: 0.55, segments: 8 }, scene)
    lantern.scaling.y = 1.3
    lantern.position.set(x * 0.94, 4.6, z * 0.94)
    lantern.material = paper
    lantern.isPickable = false
  }
  const warm = new PointLight('lanternLight', new Vector3(0, 5, -6), scene)
  warm.diffuse = new Color3(1, 0.6, 0.3)
  warm.intensity = 0.9
  warm.range = 30

  const camera = new ArcRotateCamera('cam', Math.PI / 2, 1.2, 12, new Vector3(0, 1.2, 0), scene)
  camera.minZ = 0.05
  camera.maxZ = 500
  camera.fov = 0.8
  return { scene, camera, floorY, hemi, key: moon }
}

/** A flat textured quad (UI art in 3D, e.g. the calligraphy behind the creation pedestal). */
export function artPlane(scene: Scene, name: string, url: string, width: number, height: number): Mesh {
  const plane = CreatePlane(name, { width, height, sideOrientation: Mesh.DOUBLESIDE }, scene)
  const m = new StandardMaterial(`${name}Mat`, scene)
  const tex = new Texture(url, scene, false, true)
  tex.hasAlpha = true
  m.diffuseTexture = tex
  m.useAlphaFromDiffuseTexture = true
  m.emissiveColor = new Color3(0.9, 0.9, 0.9)
  m.disableLighting = true
  m.backFaceCulling = false
  plane.material = m
  plane.isPickable = false
  return plane
}

/** Glowing ring under a character (selection highlight). */
export function selectionRing(scene: Scene): Mesh {
  const ring = CreateTorus('selRing', { diameter: 1.3, thickness: 0.06, tessellation: 48 }, scene)
  ring.material = mat(scene, 'selRingMat', new Color3(1, 0.8, 0.3), new Color3(1, 0.75, 0.25))
  ring.isPickable = false
  const disc = CreateDisc('selDisc', { radius: 0.62, tessellation: 48 }, scene)
  disc.rotation.x = Math.PI / 2
  disc.parent = ring
  const dm = mat(scene, 'selDiscMat', new Color3(1, 0.8, 0.3), new Color3(0.6, 0.45, 0.15))
  dm.alpha = 0.18
  dm.backFaceCulling = false
  disc.material = dm
  disc.isPickable = false
  return ring
}

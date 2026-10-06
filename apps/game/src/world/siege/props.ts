/**
 * Siege of Jangan, layer 4 on the client (docs/SIEGE.md §6.3, §7.1, §9.2): the things the siege puts in the world that
 * no retail model covers, made at run time from Babylon primitives and painted textures (nothing is exported):
 *
 * - **the Town Bell**: a bronze bell (a lathe of the classic bell profile, with a lip and a crown) hung from a timber
 *   frame (two posts, a beam, a small tiled roof) on a stone plinth; it swings when it is hit;
 * - **the keg**: a banded barrel with a fuse (a sapper's, on his back or at the wall), the fuse's sparks;
 * - **the blast**: a fireball burst, smoke and a short flash of light where a keg blows.
 *
 * Every mesh is unpickable and shares a handful of materials per scene; `dispose` frees what one prop made.
 */
import { mulberry32 } from '@sro/shared'
import {
  Color3,
  Color4,
  CreateBox,
  CreateCylinder,
  CreateLathe,
  CreateTorus,
  DynamicTexture,
  Mesh,
  PBRMaterial,
  ParticleSystem,
  PointLight,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Material,
  type Scene,
} from '@babylonjs/core'
import { paintWood } from '../walls/cracks.ts'

interface Mats {
  bronze: Material
  wood: Material
  darkWood: Material
  iron: Material
  stone: Material
  roof: Material
  fuse: Material
  spark: DynamicTexture | null
}

/** The world's material path: 'pbr' (physical lights) or 'classic' (the retail look). */
export type PropPath = 'pbr' | 'classic'

const MATS = new WeakMap<Scene, Map<PropPath, Mats>>()

const canPaint = () => typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined'

/** A painted texture (null where nothing can paint: tests). */
function painted(scene: Scene, name: string, w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): DynamicTexture | null {
  if (!canPaint()) return null
  const tex = new DynamicTexture(name, { width: w, height: h }, scene, true)
  paint(tex.getContext() as unknown as CanvasRenderingContext2D)
  tex.update(true)
  return tex
}

/** Rough hewn stone: grey with darker blotches and a few seams. */
function paintStone(c: CanvasRenderingContext2D, w: number, h: number): void {
  const rnd = mulberry32(0x5eed)
  c.fillStyle = 'rgb(128,124,116)'
  c.fillRect(0, 0, w, h)
  for (let i = 0; i < 260; i++) {
    const g = 90 + Math.floor(rnd() * 70)
    c.fillStyle = `rgba(${g},${g - 4},${g - 10},0.35)`
    c.beginPath()
    c.ellipse(rnd() * w, rnd() * h, 2 + rnd() * 9, 1 + rnd() * 5, rnd() * 3, 0, Math.PI * 2)
    c.fill()
  }
  c.strokeStyle = 'rgba(55,52,48,0.7)'
  c.lineWidth = 2
  for (let k = 0; k < 4; k++) {
    const x = ((k + 0.3) / 4) * w
    c.beginPath()
    c.moveTo(x, 0)
    c.lineTo(x + (rnd() - 0.5) * 10, h)
    c.stroke()
  }
}

/** Old bronze: brown-gold with green patina streaks running down. */
function paintBronze(c: CanvasRenderingContext2D, w: number, h: number): void {
  const rnd = mulberry32(0xb0e1)
  const g = c.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgb(150,112,58)')
  g.addColorStop(1, 'rgb(118,84,40)')
  c.fillStyle = g
  c.fillRect(0, 0, w, h)
  for (let i = 0; i < 40; i++) {
    const x = rnd() * w
    c.strokeStyle = `rgba(${70 + rnd() * 30},${120 + rnd() * 40},${100 + rnd() * 30},${0.18 + rnd() * 0.25})`
    c.lineWidth = 1 + rnd() * 4
    c.beginPath()
    c.moveTo(x, rnd() * h * 0.4)
    c.lineTo(x + (rnd() - 0.5) * 6, h * (0.5 + rnd() * 0.5))
    c.stroke()
  }
  // the cast bands
  c.fillStyle = 'rgba(70,48,22,0.55)'
  for (const y of [0.18, 0.22, 0.62, 0.66]) c.fillRect(0, y * h, w, 2)
}

/** Grey-green roof tiles in rows. */
function paintTiles(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.fillStyle = 'rgb(70,84,80)'
  c.fillRect(0, 0, w, h)
  for (let y = 0; y < h; y += 8) {
    c.fillStyle = 'rgba(30,38,36,0.8)'
    c.fillRect(0, y, w, 2)
    for (let x = (y / 8) % 2 ? 0 : 6; x < w; x += 12) {
      c.fillStyle = 'rgba(40,50,48,0.6)'
      c.fillRect(x, y, 1.5, 8)
    }
  }
}

function makeMat(scene: Scene, path: PropPath, name: string, o: { color: [number, number, number]; tex?: DynamicTexture | null; metal?: number; rough?: number; spec?: number }): Material {
  if (path === 'pbr') {
    const p = new PBRMaterial(name, scene)
    p.metallic = o.metal ?? 0
    p.roughness = o.rough ?? 0.9
    p.albedoColor = o.tex ? Color3.White() : new Color3(...o.color)
    if (o.tex) p.albedoTexture = o.tex
    return p
  }
  // lit like the world's Classic objects (materials.ts fromPbr: 2 × texture × light, BMT grey 0.59)
  const st = new StandardMaterial(name, scene)
  st.specularColor = new Color3(o.spec ?? 0, o.spec ?? 0, o.spec ?? 0)
  st.specularPower = 40
  st.diffuseColor = o.tex ? new Color3(0.59, 0.59, 0.59) : new Color3(...o.color)
  st.ambientColor = new Color3(0.59, 0.59, 0.59)
  if (o.tex) {
    o.tex.level = 2
    st.diffuseTexture = o.tex
  }
  return st
}

function mats(scene: Scene, path: PropPath = 'classic'): Mats {
  let byPath = MATS.get(scene)
  if (!byPath) {
    byPath = new Map()
    MATS.set(scene, byPath)
  }
  let m = byPath.get(path)
  if (m) return m
  const wood = painted(scene, 'siegePropWood', 256, 64, (c) => paintWood(c, 256, 64, 0x4b11))
  const dark = painted(scene, 'siegePropDarkWood', 256, 64, (c) => {
    paintWood(c, 256, 64, 0x4b12)
    c.fillStyle = 'rgba(30,18,10,0.45)'
    c.fillRect(0, 0, 256, 64)
  })
  m = {
    bronze: makeMat(scene, path, 'siegeBronze', { color: [0.5, 0.36, 0.17], tex: painted(scene, 'siegePropBronze', 128, 128, (c) => paintBronze(c, 128, 128)), metal: 0.85, rough: 0.42, spec: 0.55 }),
    wood: makeMat(scene, path, 'siegeWood', { color: [0.42, 0.3, 0.19], tex: wood }),
    darkWood: makeMat(scene, path, 'siegeDarkWood', { color: [0.26, 0.17, 0.1], tex: dark }),
    iron: makeMat(scene, path, 'siegeIron', { color: [0.14, 0.14, 0.15], metal: 0.7, rough: 0.6, spec: 0.3 }),
    stone: makeMat(scene, path, 'siegeStone', { color: [0.46, 0.44, 0.41], tex: painted(scene, 'siegePropStone', 128, 128, (c) => paintStone(c, 128, 128)), rough: 0.95 }),
    roof: makeMat(scene, path, 'siegeRoof', { color: [0.25, 0.3, 0.29], tex: painted(scene, 'siegePropTiles', 128, 64, (c) => paintTiles(c, 128, 64)), rough: 0.8 }),
    fuse: makeMat(scene, path, 'siegeFuse', { color: [0.62, 0.55, 0.38] }),
    spark: null,
  }
  byPath.set(path, m)
  return m
}

function sparkTexture(scene: Scene): DynamicTexture | null {
  const m = mats(scene)
  if (m.spark || !canPaint()) return m.spark
  const tex = new DynamicTexture('siegeSparkTex', { width: 32, height: 32 }, scene, false)
  const c = tex.getContext() as unknown as CanvasRenderingContext2D
  const g = c.createRadialGradient(16, 16, 1, 16, 16, 15)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, 32, 32)
  tex.update()
  tex.hasAlpha = true
  m.spark = tex
  return tex
}

function noPick<T extends Mesh>(m: T, parent: TransformNode): T {
  m.isPickable = false
  m.parent = parent
  return m
}

// ---- the Town Bell -----------------------------------------------------------------------------------------------

/** The bell's profile (radius, height) from the lip up to the crown, metres. */
export const BELL_PROFILE: readonly [number, number][] = [
  [0, 0.12],
  [0.98, 0],
  [1.04, 0.06],
  [0.98, 0.16],
  [0.86, 0.34],
  [0.74, 0.7],
  [0.66, 1.1],
  [0.6, 1.42],
  [0.52, 1.62],
  [0.3, 1.74],
  [0, 1.78],
]

export interface BellProp {
  root: TransformNode
  /** The swinging part (the bell itself). */
  bell: TransformNode
  /** Starts a swing of `amp` radians (decays over ~2 s). */
  hit(amp: number): void
  update(dt: number): void
  dispose(): void
}

/** The Town Bell in its frame, standing on the ground at the root's origin, about 4.6 m tall. */
export function buildBell(scene: Scene, name = 'siegeBell', path: PropPath = 'classic'): BellProp {
  const m = mats(scene, path)
  const root = new TransformNode(name, scene)
  // stone plinth
  const plinth = noPick(CreateCylinder(`${name}Plinth`, { height: 0.3, diameter: 4.4, tessellation: 24 }, scene), root)
  plinth.position.y = 0.15
  plinth.material = m.stone
  const step = noPick(CreateCylinder(`${name}Step`, { height: 0.22, diameter: 3.7, tessellation: 24 }, scene), root)
  step.position.y = 0.41
  step.material = m.stone
  // the frame: two posts, a beam, two struts, a roof
  for (const s of [-1, 1]) {
    const post = noPick(CreateBox(`${name}Post`, { width: 0.32, height: 4.3, depth: 0.32 }, scene), root)
    post.position.set(s * 1.6, 0.52 + 2.1, 0)
    post.material = m.wood
    const strut = noPick(CreateBox(`${name}Strut`, { width: 0.16, height: 1.2, depth: 0.16 }, scene), root)
    strut.position.set(s * 1.24, 3.95, 0)
    strut.rotation.z = s * 0.75
    strut.material = m.wood
    const foot = noPick(CreateBox(`${name}Foot`, { width: 0.6, height: 0.25, depth: 1.2 }, scene), root)
    foot.position.set(s * 1.6, 0.64, 0)
    foot.material = m.darkWood
  }
  const beam = noPick(CreateBox(`${name}Beam`, { width: 3.9, height: 0.36, depth: 0.42 }, scene), root)
  beam.position.y = 4.55
  beam.material = m.darkWood
  for (const s of [-1, 1]) {
    const slope = noPick(CreateBox(`${name}Roof`, { width: 4.5, height: 0.08, depth: 1.25 }, scene), root)
    slope.position.set(0, 5.02, s * 0.5)
    slope.rotation.x = -s * 0.55
    slope.material = m.roof
  }
  // the bell, hung from the beam (its pivot at the crown)
  const bell = new TransformNode(`${name}Swing`, scene)
  bell.parent = root
  bell.position.y = 4.35
  const shape = BELL_PROFILE.map(([r, h]) => new Vector3(r, h, 0))
  const body = noPick(CreateLathe(`${name}Body`, { shape, tessellation: 28, sideOrientation: Mesh.DOUBLESIDE }, scene), bell)
  body.position.y = -1.95
  body.material = m.bronze
  const lip = noPick(CreateTorus(`${name}Lip`, { diameter: 2.0, thickness: 0.09, tessellation: 28 }, scene), bell)
  lip.position.y = -1.88
  lip.material = m.bronze
  const band = noPick(CreateTorus(`${name}Band`, { diameter: 1.38, thickness: 0.06, tessellation: 24 }, scene), bell)
  band.position.y = -0.75
  band.material = m.bronze
  const crown = noPick(CreateTorus(`${name}Crown`, { diameter: 0.34, thickness: 0.09, tessellation: 12 }, scene), bell)
  crown.rotation.z = Math.PI / 2
  crown.position.y = -0.08
  crown.material = m.iron
  let amp = 0
  let t = 0
  return {
    root,
    bell,
    hit(a: number) {
      amp = Math.min(0.32, amp + a)
      t = 0
    },
    update(dt: number) {
      if (amp <= 0.0005) {
        bell.rotation.x = 0
        return
      }
      t += dt
      amp *= Math.exp(-dt * 1.4)
      bell.rotation.x = amp * Math.sin(t * 4.2)
    },
    dispose() {
      root.dispose(false, false)
    },
  }
}

// ---- the keg -----------------------------------------------------------------------------------------------------

export interface KegProp {
  root: TransformNode
  /** The fuse's tip (world position follows the root). */
  tip: TransformNode
  dispose(): void
}

/** A banded powder keg, 0.7 m tall, standing on the root's origin, a fuse on top. */
export function buildKeg(scene: Scene, name = 'siegeKeg', path: PropPath = 'classic'): KegProp {
  const m = mats(scene, path)
  const root = new TransformNode(name, scene)
  const body = noPick(CreateCylinder(`${name}Body`, { height: 0.72, diameterTop: 0.5, diameterBottom: 0.5, tessellation: 14, subdivisions: 2 }, scene), root)
  body.position.y = 0.36
  body.scaling.set(1, 1, 1)
  body.material = m.wood
  // the bulge: a fatter middle hoop of wood
  const belly = noPick(CreateCylinder(`${name}Belly`, { height: 0.34, diameter: 0.58, tessellation: 14 }, scene), root)
  belly.position.y = 0.36
  belly.material = m.wood
  for (const y of [0.08, 0.36, 0.64]) {
    const hoop = noPick(CreateTorus(`${name}Hoop`, { diameter: y === 0.36 ? 0.6 : 0.52, thickness: 0.035, tessellation: 16 }, scene), root)
    hoop.position.y = y
    hoop.material = m.iron
  }
  const fuse = noPick(CreateCylinder(`${name}Fuse`, { height: 0.22, diameter: 0.035, tessellation: 6 }, scene), root)
  fuse.position.set(0.08, 0.82, 0)
  fuse.rotation.z = -0.35
  fuse.material = m.fuse
  const tip = new TransformNode(`${name}Tip`, scene)
  tip.parent = root
  tip.position.set(0.12, 0.93, 0)
  return {
    root,
    tip,
    dispose() {
      root.dispose(false, false)
    },
  }
}

/** The fuse's sparks: a small fountain of orange sparks at `emitter` while started. */
export function fuseSparks(scene: Scene, emitter: TransformNode, cap = 60): ParticleSystem {
  const ps = new ParticleSystem('siegeFuseSparks', cap, scene)
  ps.particleTexture = sparkTexture(scene)
  ps.emitter = emitter as unknown as Vector3
  ps.createSphereEmitter(0.03, 1)
  ps.minEmitPower = 0.6
  ps.maxEmitPower = 1.8
  ps.emitRate = 45
  ps.minLifeTime = 0.12
  ps.maxLifeTime = 0.38
  ps.minSize = 0.03
  ps.maxSize = 0.08
  ps.gravity = new Vector3(0, -6, 0)
  ps.color1 = new Color4(1, 0.85, 0.35, 1)
  ps.color2 = new Color4(1, 0.5, 0.1, 1)
  ps.colorDead = new Color4(0.6, 0.15, 0, 0)
  ps.blendMode = ParticleSystem.BLENDMODE_ADD
  ps.start()
  return ps
}

/** A keg's blast at `at`: a fireball, smoke and a flash (gone after ~3 s). Returns the dispose. */
export function blastFx(scene: Scene, at: Vector3): () => void {
  const fire = new ParticleSystem('siegeBlastFire', 160, scene)
  fire.particleTexture = sparkTexture(scene)
  fire.emitter = at.clone()
  fire.createSphereEmitter(0.8, 1)
  fire.minEmitPower = 3
  fire.maxEmitPower = 9
  fire.minLifeTime = 0.25
  fire.maxLifeTime = 0.8
  fire.minSize = 0.4
  fire.maxSize = 1.6
  fire.gravity = new Vector3(0, 2, 0)
  fire.color1 = new Color4(1, 0.8, 0.3, 1)
  fire.color2 = new Color4(1, 0.4, 0.08, 1)
  fire.colorDead = new Color4(0.25, 0.08, 0.02, 0)
  fire.blendMode = ParticleSystem.BLENDMODE_ADD
  fire.manualEmitCount = 160
  fire.emitRate = 0
  fire.start()
  const smoke = new ParticleSystem('siegeBlastSmoke', 70, scene)
  smoke.particleTexture = sparkTexture(scene)
  smoke.emitter = at.clone()
  smoke.createSphereEmitter(1.2, 1)
  smoke.minEmitPower = 0.8
  smoke.maxEmitPower = 2.4
  smoke.minLifeTime = 1.4
  smoke.maxLifeTime = 2.6
  smoke.minSize = 1.6
  smoke.maxSize = 3.4
  smoke.gravity = new Vector3(0, 0.9, 0)
  smoke.color1 = new Color4(0.22, 0.2, 0.18, 0.75)
  smoke.color2 = new Color4(0.35, 0.32, 0.28, 0.6)
  smoke.colorDead = new Color4(0.4, 0.38, 0.35, 0)
  smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD
  smoke.manualEmitCount = 70
  smoke.emitRate = 0
  smoke.start()
  const light = new PointLight('siegeBlastLight', at.add(new Vector3(0, 1.5, 0)), scene)
  light.diffuse = new Color3(1, 0.62, 0.25)
  light.range = 30
  light.intensity = 6
  let alive = true
  const fade = scene.onBeforeRenderObservable.add(() => {
    light.intensity *= 0.86
    if (light.intensity < 0.05) light.setEnabled(false)
  })
  const stop = () => {
    if (!alive) return
    alive = false
    scene.onBeforeRenderObservable.remove(fade)
    fire.dispose()
    smoke.dispose()
    light.dispose()
  }
  setTimeout(stop, 3200)
  return stop
}

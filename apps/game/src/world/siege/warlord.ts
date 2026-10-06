/**
 * Siege of Jangan (docs/SIEGE.md §9.2, polish): what makes the Bandit Warlord stand out of his army.
 *
 * - **The look**: the retail Bandit, grown to 220 % (SIEGE_MOBS), painted by the ice-look plugin with its own ramp
 *   (WARLORD_LOOK: blackened armour shading to crimson, a gold fresnel edge), per mesh, so the ordinary Bandits that
 *   share his material are untouched.
 * - **The war banner**: a sashimono on his back (a pole, a crossbar, a crimson flag with a gold border and the war
 *   glyph), swaying as he marches.
 * - **The ring**: a slowly turning crimson-and-gold ring on the ground around him (where to fight him), tilted to the
 *   slope under him (the terrain sampled a ring's width apart a few times a second).
 * - **The beacon**: a faint red column over him that fades in with distance, so defenders can find him from the wall.
 *
 * Unlit materials, one set per scene and material path, painted once: on the PBR path an unlit PBRMaterial whose
 * painted texels are linearised once more before upload (measured: as painted they come out washed pink there, the
 * path's last pass encodes them again), on Classic a StandardMaterial lit by nothing but its own texture. The meshes are unpickable
 * and freed with the view.
 */
import { Color3, Constants, CreateCylinder, CreateDisc, CreatePlane, DynamicTexture, Material, Mesh, PBRMaterial, StandardMaterial, TransformNode, type Scene } from '@babylonjs/core'
import type { IceLook } from '../winter/ice-look.ts'
import type { PropPath } from './props.ts'

/** Blackened armour, crimson where the retail texture is bright, a gold edge light. */
export const WARLORD_LOOK: IceLook = { amount: 1, dark: [0.006, 0.005, 0.005], light: [0.15, 0.016, 0.01], gain: 1.5, fur: 0, glow: 0.3, rim: [1, 0.62, 0.18], rimPower: 3.4, rimGain: 0.35 }

/** The ring's radius (m) and how fast it turns (rad/s); it follows the slope every TILT_FRAMES frames. */
export const RING_M = 2.8
const RING_SPIN = 0.35
const TILT_FRAMES = 8
/** The beacon: height (m); it fades in between these camera distances (m). */
const BEACON_M = 34
export const BEACON_FADE: readonly [number, number] = [18, 45]
const BEACON_ALPHA = 0.4

interface Mats {
  cloth: Material
  pole: Material
  ring: Material
  beacon: Material
}

const MATS = new WeakMap<Scene, Map<PropPath, Mats>>()

const canPaint = () => typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined'

/** sRGB byte → linear byte (the PBR path's texels). */
export function linearByte(v: number): number {
  const c = v / 255
  return Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
}

/** A painted texture (null where nothing can paint: tests); `linear` converts its texels for the PBR path. */
function painted(scene: Scene, name: string, w: number, h: number, linear: boolean, paint: (c: CanvasRenderingContext2D) => void): DynamicTexture | null {
  if (!canPaint()) return null
  const tex = new DynamicTexture(name, { width: w, height: h }, scene, true)
  const c = tex.getContext() as unknown as CanvasRenderingContext2D
  paint(c)
  if (linear) {
    const img = c.getImageData(0, 0, w, h)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      d[i] = linearByte(d[i]!)
      d[i + 1] = linearByte(d[i + 1]!)
      d[i + 2] = linearByte(d[i + 2]!)
    }
    c.putImageData(img, 0, 0)
  }
  tex.update(true)
  return tex
}

/** The flag: a crimson field with folds, a gold border, a swallowtail and a black disc with the gold war glyph. */
function paintBanner(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.clearRect(0, 0, w, h)
  const notch = h * 0.16
  c.beginPath()
  c.moveTo(0, 0)
  c.lineTo(w, 0)
  c.lineTo(w, h)
  c.lineTo(w / 2, h - notch)
  c.lineTo(0, h)
  c.closePath()
  const g = c.createLinearGradient(0, 0, w, 0)
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, i % 2 ? 'rgb(150,18,14)' : 'rgb(112,10,8)')
  c.fillStyle = g
  c.fill()
  c.lineWidth = 7
  c.strokeStyle = 'rgb(226,170,62)'
  c.stroke()
  c.lineWidth = 2
  c.strokeStyle = 'rgb(60,8,4)'
  c.stroke()
  const cx = w / 2
  const cy = h * 0.4
  const r = w * 0.32
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.fillStyle = 'rgb(18,8,6)'
  c.fill()
  c.lineWidth = 4
  c.strokeStyle = 'rgb(226,170,62)'
  c.stroke()
  c.fillStyle = 'rgb(240,190,80)'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.font = `bold ${Math.round(r * 1.25)}px "SimSun", "MS Mincho", serif`
  c.fillText('戰', cx, cy + r * 0.05)
}

/** The ground ring: a crimson band with a gold rim, gold chevrons pointing in, a clear centre. */
function paintRing(c: CanvasRenderingContext2D, s: number): void {
  c.clearRect(0, 0, s, s)
  const m = s / 2
  const band = c.createRadialGradient(m, m, m * 0.62, m, m, m * 0.98)
  band.addColorStop(0, 'rgba(255,40,20,0)')
  band.addColorStop(0.55, 'rgba(170,14,6,0.6)')
  band.addColorStop(0.85, 'rgba(200,22,10,0.75)')
  band.addColorStop(1, 'rgba(255,40,20,0)')
  c.fillStyle = band
  c.fillRect(0, 0, s, s)
  c.strokeStyle = 'rgba(255,190,70,0.85)'
  c.lineWidth = s * 0.012
  for (const r of [0.66, 0.9]) {
    c.beginPath()
    c.arc(m, m, m * r, 0, Math.PI * 2)
    c.stroke()
  }
  c.fillStyle = 'rgba(255,195,80,0.85)'
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    c.save()
    c.translate(m + Math.cos(a) * m * 0.78, m + Math.sin(a) * m * 0.78)
    c.rotate(a + Math.PI / 2)
    c.beginPath()
    c.moveTo(-m * 0.05, -m * 0.035)
    c.lineTo(0, m * 0.04)
    c.lineTo(m * 0.05, -m * 0.035)
    c.lineTo(0, -m * 0.005)
    c.closePath()
    c.fill()
    c.restore()
  }
}

/** The beacon's column: bright at the foot, gone at the top. */
function paintBeacon(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, h, 0, 0)
  g.addColorStop(0, 'rgba(255,70,40,1)')
  g.addColorStop(0.25, 'rgba(255,60,30,0.55)')
  g.addColorStop(1, 'rgba(255,40,20,0)')
  c.clearRect(0, 0, w, h)
  c.fillStyle = g
  c.fillRect(0, 0, w, h)
}

type Blend = 'opaque' | 'cutout' | 'blend' | 'add'

/**
 * An unlit material showing `tex` (or the sRGB colour `color` without one) as it is painted. `blend`: opaque, cut out
 * at alpha 0.5 (the swallowtail), alpha-blended or added (the glows; the texture's alpha is the opacity).
 */
function unlit(scene: Scene, path: PropPath, name: string, tex: DynamicTexture | null, color: [number, number, number], blend: Blend): Material {
  if (tex) tex.hasAlpha = blend !== 'opaque'
  const alpha = blend === 'blend' || blend === 'add'
  let m: Material
  if (path === 'pbr') {
    const p = new PBRMaterial(name, scene)
    p.unlit = true
    p.albedoColor = tex ? Color3.White() : new Color3(...color).toLinearSpace()
    if (tex) {
      p.albedoTexture = tex
      p.useAlphaFromAlbedoTexture = blend !== 'opaque'
    }
    m = p
  } else {
    // Babylon adds the emissive colour to the emissive texture, so it stays black with one
    const st = new StandardMaterial(name, scene)
    st.disableLighting = true
    st.diffuseColor = Color3.Black()
    st.specularColor = Color3.Black()
    st.emissiveColor = tex ? Color3.Black() : new Color3(...color)
    if (tex) {
      st.emissiveTexture = tex
      if (blend === 'cutout') st.diffuseTexture = tex
      else if (alpha) st.opacityTexture = tex
    }
    m = st
  }
  m.backFaceCulling = false
  if (blend === 'cutout') {
    m.transparencyMode = Material.MATERIAL_ALPHATEST
    ;(m as PBRMaterial | StandardMaterial).alphaCutOff = 0.5
  } else if (alpha) {
    m.transparencyMode = Material.MATERIAL_ALPHABLEND
    m.alphaMode = blend === 'add' ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
    m.disableDepthWrite = true
  }
  return m
}

function mats(scene: Scene, path: PropPath): Mats {
  let byPath = MATS.get(scene)
  if (!byPath) {
    byPath = new Map()
    MATS.set(scene, byPath)
  }
  let m = byPath.get(path)
  if (m) return m
  const lin = path === 'pbr'
  const flag = painted(scene, `siegeWarlordFlag${path}`, 128, 192, lin, (c) => paintBanner(c, 128, 192))
  const ring = painted(scene, `siegeWarlordRingTex${path}`, 256, 256, lin, (c) => paintRing(c, 256))
  const beacon = painted(scene, `siegeWarlordBeaconTex${path}`, 8, 128, lin, (c) => paintBeacon(c, 8, 128))
  m = {
    cloth: unlit(scene, path, 'siegeWarlordCloth', flag, [0.5, 0.05, 0.03], 'cutout'),
    pole: unlit(scene, path, 'siegeWarlordPole', null, [0.2, 0.11, 0.06], 'opaque'),
    // blended, not added: deep red and gold even on sunlit stone
    ring: unlit(scene, path, 'siegeWarlordRing', ring, [0.7, 0.08, 0.04], 'blend'),
    beacon: unlit(scene, path, 'siegeWarlordBeacon', beacon, [0.8, 0.15, 0.08], 'add'),
  }
  m.ring.zOffset = -2
  byPath.set(path, m)
  return m
}

/** The beacon's alpha at a camera distance `d` (m). */
export function beaconAlpha(d: number): number {
  const [a, b] = BEACON_FADE
  return BEACON_ALPHA * Math.max(0, Math.min(1, (d - a) / (b - a)))
}

export interface WarlordGear {
  /** Each frame: `t` seconds, `camDist` the camera's distance (m), `shown` false hides it all (dead). */
  update(t: number, dt: number, camDist: number, shown: boolean): void
  dispose(): void
}

/**
 * The banner on `body` (the actor's root: model units, turned with him) and the ring and beacon on `ground` (the
 * entity's root at his feet, in metres).
 */
export function buildWarlordGear(
  scene: Scene,
  name: string,
  body: TransformNode,
  ground: TransformNode,
  path: PropPath = 'classic',
  heightAt: ((x: number, z: number) => number) | null = null,
): WarlordGear {
  const m = mats(scene, path)
  const made: Mesh[] = []
  const add = <T extends Mesh>(mesh: T, parent: TransformNode): T => {
    mesh.isPickable = false
    mesh.parent = parent
    made.push(mesh)
    return mesh
  }
  // the banner: a pole up from his back, a crossbar, the flag hanging from it (model units, the bandit is ~1.8 tall)
  const banner = new TransformNode(`${name}Banner`, scene)
  banner.parent = body
  banner.position.set(0, 0.95, -0.3)
  banner.rotation.x = -0.12
  const pole = add(CreateCylinder(`${name}Pole`, { height: 1.9, diameter: 0.045, tessellation: 6 }, scene), banner)
  pole.position.y = 1.03
  pole.material = m.pole
  const bar = add(CreateCylinder(`${name}Bar`, { height: 0.62, diameter: 0.035, tessellation: 6 }, scene), banner)
  bar.rotation.z = Math.PI / 2
  bar.position.y = 1.96
  bar.material = m.pole
  const hinge = new TransformNode(`${name}Hinge`, scene)
  hinge.parent = banner
  hinge.position.y = 1.96
  const flag = add(CreatePlane(`${name}Flag`, { width: 0.58, height: 0.87, sideOrientation: Mesh.DOUBLESIDE }, scene), hinge)
  flag.position.set(0, -0.45, -0.02)
  flag.material = m.cloth
  // the ring and the beacon, at his feet
  const tilt = new TransformNode(`${name}Tilt`, scene)
  tilt.parent = ground
  tilt.position.y = 0.14
  const ring = add(CreateDisc(`${name}Ring`, { radius: RING_M, tessellation: 48 }, scene), tilt)
  ring.rotation.x = Math.PI / 2
  ring.material = m.ring
  let frames = 0
  /** Lays the ring on the slope: the height differences across it, east-west and north-south. */
  const lay = () => {
    if (!heightAt) return
    const p = ground.getAbsolutePosition()
    const sx = (heightAt(p.x + RING_M, p.z) - heightAt(p.x - RING_M, p.z)) / (2 * RING_M)
    const sz = (heightAt(p.x, p.z + RING_M) - heightAt(p.x, p.z - RING_M)) / (2 * RING_M)
    if (!Number.isFinite(sx) || !Number.isFinite(sz)) return
    tilt.rotation.z = Math.atan(sx)
    tilt.rotation.x = -Math.atan(sz)
  }
  const beacon = add(CreateCylinder(`${name}Beacon`, { height: BEACON_M, diameterTop: 0.4, diameterBottom: 1.2, tessellation: 14, cap: Mesh.NO_CAP }, scene), ground)
  beacon.position.y = BEACON_M / 2
  beacon.material = m.beacon
  beacon.visibility = 0
  let shownNow = true
  return {
    update(t, dt, camDist, shown) {
      if (shown !== shownNow) {
        shownNow = shown
        banner.setEnabled(shown)
        ring.setEnabled(shown)
        beacon.setEnabled(shown)
      }
      if (!shown) return
      hinge.rotation.x = Math.sin(t * 1.9) * 0.09 + Math.sin(t * 3.1) * 0.03
      // the disc lies in its XY plane: Z turns it in place
      ring.rotation.z = (ring.rotation.z + dt * RING_SPIN) % (Math.PI * 2)
      if (frames++ % TILT_FRAMES === 0) lay()
      ring.visibility = 0.8 + 0.2 * Math.sin(t * 2.4)
      beacon.visibility = beaconAlpha(camDist)
      beacon.isVisible = beacon.visibility > 0.01
    },
    dispose() {
      for (const x of made) if (!x.isDisposed()) x.dispose(false, false)
      made.length = 0
      if (!banner.isDisposed()) banner.dispose()
      if (!tilt.isDisposed()) tilt.dispose()
    },
  }
}

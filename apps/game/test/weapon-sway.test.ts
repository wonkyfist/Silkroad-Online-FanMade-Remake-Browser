/**
 * Weapons' cloth in the wind and the v3 rarity pulse (docs/RARITY.md §5.10, §6): which parts of a weapon sway (a flat
 * card and a thin strip hanging off a shaft do, the shaft and square ornaments do not; the overrides by centre), the
 * sway's TS mirror (pinned at the attachment, growing to the free end, stronger in storms), the inertia spring, the
 * shader code in both languages, the idle pulse, the outline and the heart of a weapon, and the converted weapons
 * themselves (when the equipment set is there).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Vector3 } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { SWAY_OVERRIDES, subdivideParts, swayModelName, swayOffset, swayParts, swayStrength } from '../src/three/weapon-sway-parts.ts'
import { SWAY_LAG_S, springStep, swayCode } from '../src/three/weapon-sway.ts'
import { OUTLINE_BINS, PULSE_S, heartOf, outlineOf, pulseOf, rarityVertexCode } from '../src/three/weapon-rarity.ts'
import { SHELL_LAYERS, SHELL_SHADERS } from '../src/world/rarity/shell.ts'

/** A box (8 corners, 12 triangles) from min to max, appended to pos / idx. */
function box(pos: number[], idx: number[], min: number[], max: number[]): void {
  const o = pos.length / 3
  for (let i = 0; i < 8; i++) pos.push(i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!)
  const f = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]
  for (const v of f) idx.push(o + v)
}

/** A flat card (zero thickness) in the xz plane: 2 × `rows` quads. */
function card(pos: number[], idx: number[], x0: number, x1: number, z0: number, z1: number, rows = 4): void {
  const o = pos.length / 3
  for (let r = 0; r <= rows; r++) {
    const z = z0 + ((z1 - z0) * r) / rows
    pos.push(x0, 0, z, x1, 0, z)
  }
  for (let r = 0; r < rows; r++) {
    const a = o + r * 2
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2)
  }
}

/** A spear: a 2 m shaft along z, a ribbon card hanging off its head, a thin cord strip, a square metal ornament. */
function spear() {
  const pos: number[] = []
  const idx: number[] = []
  box(pos, idx, [-0.02, -0.02, -0.5], [0.02, 0.02, 1.5])
  card(pos, idx, 0.02, 0.08, 0.6, 1.3, 2) // ribbon: 0.7 long, 0.06 wide, its top at the head
  box(pos, idx, [-0.07, -0.004, 0.9], [-0.05, 0.004, 1.3]) // a cord: 0.4 long, 2 cm wide, 8 mm thick
  card(pos, idx, -0.2, -0.1, 1.2, 1.3) // a square card (a metal wing): rigid
  return { pos, idx }
}

describe('swaying parts', () => {
  it('a hanging card and a thin cord sway; the shaft and a square ornament do not', () => {
    const { pos, idx } = spear()
    const r = swayParts(pos, idx)
    expect(r.islands).toBe(4)
    expect(r.parts.map(p => p.reason).sort()).toEqual(['card', 'strip'])
    const rib = r.parts.find(p => p.reason === 'card')!
    expect(rib.length).toBeCloseTo(0.7, 2)
    expect(rib.thickness).toBeLessThan(0.001)
    // pinned at the head end (nearest the shaft's top), free at the bottom
    expect(rib.pin[2]).toBeCloseTo(1.3, 2)
    expect(rib.free[2]).toBeCloseTo(0.6, 2)
    const d = r.data!
    // the shaft's 8 vertices are rigid; the ribbon's weight runs 0 at the pin to 1 at the free end
    for (let i = 0; i < 8; i++) expect(d[i * 4]).toBe(0)
    const top = 8 + 4
    const bottom = 8
    expect(d[top * 4]).toBeCloseTo(0, 3)
    expect(d[bottom * 4]).toBeCloseTo(1, 3)
    expect(d[bottom * 4 + 2]).toBeCloseTo(0.7, 2)
  })

  it('a model with no thin parts has no data; overrides add and drop islands by their centre', () => {
    const pos: number[] = []
    const idx: number[] = []
    box(pos, idx, [-0.02, -0.02, 0], [0.02, 0.02, 1])
    expect(swayParts(pos, idx).data).toBeNull()
    const s = spear()
    const cord = [-0.06, 0, 1.1] as const
    const parts = swayParts(s.pos, s.idx, 'test_spear')
    expect(parts.parts.length).toBe(2)
    ;(SWAY_OVERRIDES as Record<string, unknown>)['test_spear'] = { drop: [cord] }
    try {
      expect(swayParts(s.pos, s.idx, 'test_spear').parts.map(p => p.reason)).toEqual(['card'])
    } finally {
      delete (SWAY_OVERRIDES as Record<string, unknown>)['test_spear']
    }
  })

  it('names the model from its glb path', () => {
    expect(swayModelName('/out-opt/item/china/weapon/Spear_08.glb')).toBe('spear_08')
    expect(swayModelName('spear_08')).toBe('spear_08')
  })
})

describe('the cards bend', () => {
  it('subdivides only the swaying triangles, shares edge midpoints, interpolates every stream', () => {
    const { pos, idx } = spear()
    const r = swayParts(pos, idx)
    const n = pos.length / 3
    const uv = Array.from({ length: n * 2 }, (_, i) => i % 2 ? 0 : i / 2)
    const sub = subdivideParts({ position: { data: pos, stride: 3 }, uv: { data: uv, stride: 2 }, sroSway: { data: r.data!, stride: 4 } }, idx, i => r.data![i * 4 + 2]! > 0, 2)
    const swayTris = (2 * 2) + 12 // the ribbon (2 quads) and the cord (a box)
    expect(sub.indices.length / 3).toBe(idx.length / 3 - swayTris + swayTris * 16)
    const m = sub.streams.position!.length / 3
    expect(sub.streams.uv!.length / 2).toBe(m)
    expect(sub.streams.sroSway!.length / 4).toBe(m)
    // the ribbon's new rows carry weights between its pin (0) and free end (1): it can bend in 4 steps now
    const ws = new Set<number>()
    for (let i = n; i < m; i++) if (sub.streams.sroSway![i * 4 + 2]! > 0.6) ws.add(Math.round(sub.streams.sroSway![i * 4]! * 100))
    expect([25, 50, 75].every(w => ws.has(w))).toBe(true)
    // the shaft is untouched (its 12 triangles stay first, the same)
    expect(sub.indices.slice(0, 36)).toEqual(Array.from(idx).slice(0, 36))
  })
})

describe('the sway', () => {
  it('is pinned at the attachment and grows to the free end; a storm pushes harder than a breeze', () => {
    expect(swayOffset(0, 0.3, 0.7, 0.5, 2, 1, 0, 1)).toEqual([0, 0, 0])
    const amp = (w: number, s: number) => {
      let m = 0
      for (let t = 0; t < 6; t += 0.05) {
        const o = swayOffset(w, 0.3, 0.7, 0.5, t, 1, 0, s)
        m = Math.max(m, Math.hypot(o[0], o[1], o[2]))
      }
      return m
    }
    expect(amp(0.5, 1)).toBeGreaterThan(0)
    expect(amp(1, 1)).toBeGreaterThan(amp(0.5, 1) * 1.5)
    expect(amp(1, swayStrength(20))).toBeGreaterThan(amp(1, swayStrength(2)) * 2)
    // never longer than the part could reach in the strongest storm
    expect(amp(1, swayStrength(60))).toBeLessThan(0.7 * 2)
    // a breeze always (calm air still moves the cloth), storms capped
    expect(swayStrength(0)).toBeGreaterThan(0.1)
    expect(swayStrength(100)).toBeLessThanOrEqual(1.4)
  })

  it('the spring trails the motion, settles, and stays capped', () => {
    const d = new Vector3()
    const v = new Vector3()
    // running forward at 5 m/s: the cloth trails behind
    for (let i = 0; i < 120; i++) springStep(d, v, new Vector3(5, 0, 0), 1 / 60)
    expect(d.x).toBeLessThan(0)
    expect(d.x).toBeCloseTo(-5 * SWAY_LAG_S, 1)
    // stopping: it swings past and settles back
    let min = 0
    let max = -1
    for (let i = 0; i < 240; i++) {
      springStep(d, v, Vector3.Zero(), 1 / 60)
      min = Math.min(min, d.x)
      max = Math.max(max, d.x)
    }
    expect(max).toBeGreaterThan(0)
    expect(Math.abs(d.x)).toBeLessThan(0.02)
    // a whip of a swing (40 m/s) stays capped
    for (let i = 0; i < 30; i++) springStep(d, v, new Vector3(0, 0, 40), 1 / 60)
    expect(d.length()).toBeLessThanOrEqual(0.9 + 1e-6)
  })

  it('the vertex code in both languages, no idiom of the other', () => {
    for (const lang of ['glsl', 'wgsl'] as const) {
      const c = swayCode(lang)
      expect(Object.keys(c).sort()).toEqual(['CUSTOM_VERTEX_DEFINITIONS', 'CUSTOM_VERTEX_UPDATE_WORLDPOS'])
      const all = Object.values(c).join('\n')
      expect(all).toContain('#ifdef SROSWAY')
      expect(all).toContain('sroSway')
      if (lang === 'wgsl') {
        expect(all).not.toMatch(/\bvec3\(|\bfloat\b/)
        expect(all).toContain('vertexOutputs.vPositionW')
      } else {
        expect(all).not.toMatch(/\bvec3f\b|\blet\b|uniforms\./)
      }
      const v = Object.values(rarityVertexCode(lang)).join('\n')
      expect(v).toContain('#ifndef SROSWAY')
      expect(v).toContain('vSroSw')
    }
  })
})

describe('the v3 rarity', () => {
  it('the idle pulse breathes once per cycle and flashes at its peak; two owners are out of step', () => {
    let peak = 0
    let peakAt = 0
    for (let s = 0; s < PULSE_S; s += 0.01) {
      const q = pulseOf(s, 0)
      expect(q.breath).toBeGreaterThanOrEqual(0)
      expect(q.breath).toBeLessThanOrEqual(1)
      if (q.flash > peak) {
        peak = q.flash
        peakAt = s
      }
    }
    expect(peak).toBeGreaterThan(0.95)
    expect(pulseOf(peakAt, 0).breath).toBeGreaterThan(0.95)
    expect(pulseOf(0, 0).flash).toBeLessThan(0.01)
    expect(pulseOf(1, 0).breath).not.toBeCloseTo(pulseOf(1, 0.37).breath, 2)
  })

  it('the outline is the widest vertex per side per bin; the heart is where the head is widest', () => {
    // a diamond: widest (±0.3) at 60 % of the way to the tip
    const pos = [0, 0, 0, 0.3, 0, 0.6, -0.3, 0, 0.6, 0, 0, 1, 0.1, 0, 0.3, -0.1, 0, 0.3, 0.1, 0, 0.8, -0.1, 0, 0.8]
    const o = outlineOf(pos, null, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 })
    expect(o.length).toBe(OUTLINE_BINS * 6)
    const b = Math.floor(0.6 * OUTLINE_BINS)
    expect(o[b * 6]).toBeCloseTo(-0.3)
    expect(o[b * 6 + 3]).toBeCloseTo(0.3)
    expect(heartOf(o, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 })).toBeCloseTo((b + 0.5) / OUTLINE_BINS)
    // swaying vertices are not the silhouette
    const sway = new Float32Array((pos.length / 3) * 4)
    sway[1 * 4] = 1
    const o2 = outlineOf(pos, sway, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 })
    expect(o2[b * 6 + 3]).not.toBeCloseTo(0.3)
  })

  it('the aura shells step out, inner brightest, in both languages', () => {
    for (let i = 1; i < SHELL_LAYERS.length; i++) {
      expect(SHELL_LAYERS[i]!.margin).toBeGreaterThan(SHELL_LAYERS[i - 1]!.margin)
      expect(SHELL_LAYERS[i]!.gain).toBeLessThan(SHELL_LAYERS[i - 1]!.gain)
    }
    expect(SHELL_SHADERS.wgsl.vertex).toContain('uniforms.projection')
    expect(SHELL_SHADERS.glsl.vertex).toContain('projection * vec4(vp, 1.0)')
    expect(SHELL_SHADERS.wgsl.vertex).not.toMatch(/\bmesh\./)
  })
})

const DIR = join(__dirname, '../../../work/out/item/china/weapon')
// the glTF reader lives with the converter's packages
const { NodeIO } = createRequire(join(__dirname, '../../../packages/texpipe/package.json'))('@gltf-transform/core') as typeof import('@gltf-transform/core')
const has = existsSync(DIR)

describe.skipIf(!has)('the converted weapons', () => {
  it('3 Chinese weapons carry swaying parts (4 parts): the degree 2-4 spear tassels (degrees 5-8 are above the level cap)', async () => {
    const io = new NodeIO()
    let models = 0
    let parts = 0
    const byModel: Record<string, number[]> = {}
    for (const f of readdirSync(DIR).filter(f => /^(sword|blade|spear|tblade|bow)_0\d\.glb$/.test(f))) {
      const doc = await io.read(join(DIR, f))
      const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
      const r = swayParts(prim.getAttribute('POSITION')!.getArray()!, prim.getIndices()!.getArray()!, f.replace('.glb', ''))
      if (r.parts.length) models++
      parts += r.parts.length
      byModel[f.replace('.glb', '')] = r.parts.map(p => p.length)
      for (const p of r.parts) {
        expect(p.length).toBeGreaterThan(0.04)
        expect(p.length).toBeLessThan(1.4)
      }
    }
    expect(models).toBe(3)
    expect(parts).toBe(4)
    expect(byModel['spear_04']!.length).toBe(2)
    expect(byModel['bow_04']).toEqual([])
  })
})

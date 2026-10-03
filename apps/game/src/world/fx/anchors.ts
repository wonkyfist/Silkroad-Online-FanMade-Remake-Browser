/**
 * Where effects sit (docs/EFFECTS.md §1.3, §2.1, M9, M10, M18): the skilleffect offsets (decimetres in the model's own
 * frame -> glTF metres), the caster's facing frame, bone anchors, the victim's DamagePos (characterInfo), the flight
 * end point, and the carrier scale of MOB_BASE / CHAR_BASE rows. Pure maths on EntityView-like objects, so the tests
 * drive it with fakes.
 */
import type { M3, V3 } from '@sro/fx'
import type { EntityView } from '../entities.ts'
import type { FxCharacterInfo, FxLight } from './types.ts'

/** What the anchors read of a view (EntityView in the game). */
export type AnchorView = Pick<EntityView, 'root' | 'yaw' | 'height' | 'actor' | 'isDisposed'> & { scale?: number; state?: { model?: string } }

/** "0,10,-13" in client units (dm, file space) -> glTF metres (x, y, -z) x 0.1. */
export function parseOffset(s: string | null | undefined): V3 {
  const v = (s ?? '').split(',').map(Number)
  const [x = 0, y = 0, z = 0] = v.map(n => (Number.isFinite(n) ? n : 0))
  return [x * 0.1, y * 0.1, z ? -z * 0.1 : 0]
}

/** A raw characterInfo DamagePos ([x, y, z] dm, file frame) -> glTF metres, like parseOffset. */
export function dmToMetres(v: readonly number[] | null | undefined): V3 {
  const [x = 0, y = 0, z = 0] = (v ?? []).map(n => (Number.isFinite(n) ? n : 0))
  return [x * 0.1, y * 0.1, z ? -z * 0.1 : 0]
}

/** Column-major rotation of a facing (yaw about +Y; glTF models face +Z), rolled about its forward axis. */
export function facing(yaw: number, roll = 0): M3 {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const x: V3 = [c, 0, -s]
  const y: V3 = [0, 1, 0]
  const z: V3 = [s, 0, c]
  if (!roll) return [...x, ...y, ...z]
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  const rx: V3 = [cr * x[0] + sr * y[0], cr * x[1] + sr * y[1], cr * x[2] + sr * y[2]]
  const ry: V3 = [-sr * x[0] + cr * y[0], -sr * x[1] + cr * y[1], -sr * x[2] + cr * y[2]]
  return [...rx, ...ry, ...z]
}

/** A frame whose +Z looks along `dir` (arrows, flights), +Y kept as up as far as possible. */
export function lookAlong(dir: V3): M3 {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const z: V3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  let x = cross([0, 1, 0], z)
  const xl = Math.hypot(x[0], x[1], x[2])
  x = xl < 1e-6 ? [1, 0, 0] : [x[0] / xl, x[1] / xl, x[2] / xl]
  const y = cross(z, x)
  return [...x, ...y, ...z]
}

export function rotate(m: M3, v: V3): V3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scaleV = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
export const lerp = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
export const dist = (a: V3, b: V3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])

/** Root scale of a view (players' Height, a mob's Scale); 1 when unknown. */
export function rootScale(view: AnchorView): number {
  const s = view.scale
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
}

export function rootPoint(view: AnchorView): V3 {
  const r = view.root.position
  return [r.x, r.y, r.z]
}

/** World position of a joint of the view's model, or null (no model, no such joint). */
export function jointPoint(view: AnchorView, bone: string | null | undefined): V3 | null {
  if (!bone) return null
  const node = view.actor?.joint(bone)
  if (!node) return null
  const m = node.computeWorldMatrix(true).m
  return [m[12]!, m[13]!, m[14]!]
}

/**
 * A stage anchor on a view: its start bone (or the root when the bone is missing or not given) plus the offset turned
 * by `rot` (the caster's facing) and scaled with the carrier (offsets scale with the root, M18).
 */
export function anchorPoint(view: AnchorView, bone: string | null | undefined, offset: V3, rot: M3): V3 {
  const p = jointPoint(view, bone) ?? rootPoint(view)
  return add(p, rotate(rot, scaleV(offset, rootScale(view))))
}

/** The hit position on a body without characterInfo: about chest height. */
export function bodyPoint(view: AnchorView): V3 {
  const r = view.root.position
  return [r.x, r.y + view.height * 0.55, r.z]
}

/** CodeName128 -> characterInfo row. */
export type CharacterIndex = ReadonlyMap<string, FxCharacterInfo>

/** Reads fx index v2 `characters` (tolerant: a v1 index gives an empty map). */
export function readCharacters(json: unknown): Map<string, FxCharacterInfo> {
  const out = new Map<string, FxCharacterInfo>()
  const c = (json as { characters?: unknown } | null)?.characters
  if (!c || typeof c !== 'object') return out
  for (const [code, row] of Object.entries(c as Record<string, unknown>)) {
    const r = row as Partial<FxCharacterInfo> | null
    if (!r || typeof r !== 'object' || !Array.isArray(r.damagePos)) continue
    out.set(code, {
      size: typeof r.size === 'number' ? r.size : 2,
      damageBone: typeof r.damageBone === 'string' ? r.damageBone : null,
      damagePos: [Number(r.damagePos[0]) || 0, Number(r.damagePos[1]) || 0, Number(r.damagePos[2]) || 0],
      bloodType: typeof r.bloodType === 'string' ? r.bloodType : null,
      dieModel: r.dieModel ?? null,
      ride: r.ride ?? null,
    })
  }
  return out
}

/** Reads fx index v2 `lights` (LIGHT_n). */
export function readLights(json: unknown): Map<string, FxLight> {
  const out = new Map<string, FxLight>()
  const l = (json as { lights?: unknown } | null)?.lights
  if (!l || typeof l !== 'object') return out
  for (const [k, v] of Object.entries(l as Record<string, unknown>)) {
    const r = v as Partial<FxLight> | null
    if (r && Array.isArray(r.argb) && r.argb.length === 4) out.set(k, { argb: r.argb as FxLight['argb'], timeMs: Number(r.timeMs) || 300, range: Number(r.range) || 1000, atten: Number(r.atten) || 0.2 })
  }
  return out
}

/** The characterInfo row of a view (its model code), or undefined. */
export function infoOf(view: AnchorView, chars: CharacterIndex): FxCharacterInfo | undefined {
  const code = view.state?.model
  return code ? chars.get(code) : undefined
}

/**
 * Where a hit lands on `victim` (M9): its characterInfo DamagePos in its own frame (turned with its facing, scaled
 * with its root; at the DamageBone when it has one), else 0.55 x its height.
 */
export function damagePoint(victim: AnchorView, info: FxCharacterInfo | undefined): V3 {
  if (!info) return bodyPoint(victim)
  const off = dmToMetres(info.damagePos)
  const bone = info.damageBone ? jointPoint(victim, info.damageBone) : null
  const base = bone ?? rootPoint(victim)
  return add(base, rotate(facing(victim.yaw), scaleV(off, rootScale(victim))))
}

/** End of a flight (M10): the target root + TargetOffset in the target's own frame (scaled with it). */
export function flightEnd(target: AnchorView, targetOffset: V3, info?: FxCharacterInfo): V3 {
  // A zero offset aims at the body (characterInfo DamagePos height), not the feet.
  if (!targetOffset[0] && !targetOffset[1] && !targetOffset[2]) return damagePoint(target, info)
  return add(rootPoint(target), rotate(facing(target.yaw), scaleV(targetOffset, rootScale(target))))
}

/** MOB_BASE effect scale: characterInfo Size / 2 [our rule, docs/EFFECTS.md §1.2], clamped. */
export function mobBaseScale(info: FxCharacterInfo | undefined, view: AnchorView): number {
  const size = info?.size ?? view.height
  return Math.max(0.7, Math.min(2.5, size / 2))
}

/** Scale of an effect on its carrier by the row's Scale column (players: their Height; others: 1). */
export function stageScale(scale: string | null | undefined, view: AnchorView, info: FxCharacterInfo | undefined): number {
  if (scale === 'MOB_BASE') return mobBaseScale(info, view)
  return rootScale(view)
}

/** A hit light's colour (0..1) from its ARGB row. */
export function lightColor(l: FxLight): [number, number, number] {
  return [l.argb[1] / 255, l.argb[2] / 255, l.argb[3] / 255]
}

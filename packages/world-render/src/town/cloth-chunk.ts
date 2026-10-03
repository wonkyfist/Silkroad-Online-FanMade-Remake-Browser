/**
 * The cloth sway chunk (docs/TOWN_LIFE.md §5.1; docs/WAVE_PLAN7.md D3, §6.1 TL-M). The foliage plugin
 * (pbr/foliage-plugin.ts) injects these strings into a region batch's `+sheen` group material under the define
 * `SRO_CLOTH_WIND` (W11-S's slot); **TL-M owns this file** and never edits the plugin.
 *
 * What the slot gives the chunk, in both languages (no GLSL reaches WebGPU):
 *   - `CLOTH_VERTEX_DEFS_*` sit in `CUSTOM_VERTEX_DEFINITIONS` under `SRO_CLOTH_WIND`, after the slot's declarations:
 *     the attribute `sroPivot` (vec4: pin height, hanging height, kind code, phase; world space, batch/region-batch.ts
 *     `clothPivots`) and WX-R's `sroWind(root)` (weather/chunks.ts).
 *   - `CLOTH_WORLDPOS_*` sit in `CUSTOM_VERTEX_UPDATE_WORLDPOS` under `SRO_CLOTH_WIND`, inside a block that declares
 *     `clothPivot` (the attribute; kind 0 = no sway: a `+sheen` piece without a cloth record) and, after the chunk,
 *     writes `worldPos.xyz` to `vPositionW`. The chunk moves `worldPos`.
 *   - The uniforms are the foliage plugin's UBO: `wxA`, `wxB` (the weather's wind vectors; `wxB.w` its clock) and
 *     `sroFol` (`.y`: the minimum breeze, FOLIAGE_MIN_BREEZE; `SRO_FOL_BREEZE` is on with it). No new uniform, sampler or
 *     varying (material-budgets.test.ts).
 *
 * TL-M (the prototype's `TownSway` math, work/tmp/town-life/lab/town-lab.ts, made per piece): a vertex `u` along the
 * piece, from its pin (`hanging`, `awning`: 0 at the top edge, 1 at the free edge; `tent`: 0 at the base, 1 at the
 * top), a weight `w` (hanging, awning: `u²`, and 0 below the band, `u > 1.02`, so a converter pin can name the cloth
 * part of a primitive and leave the rest still; tent: `sin(π u)`, both edges held and the middle breathing), and the
 * offset `strength × min(0.35 × height, 1 m) × w × gust × (0.55 + flap)` along the weather's wind: a slow gust per
 * piece (its phase) and a flap wave running down and across the cloth. A hanging piece also lifts as it swings out;
 * an awning swings half as far and flutters up and down; a tent billows at 0.6×. The strength is the weather's
 * (`wxB.z`) or the minimum breeze, so calm air still breathes. `clothSway` is the TS mirror (tests).
 */

/** The weight band's end for `hanging` and `awning`: below `pin − height × CLOTH_BAND_END` nothing moves. */
export const CLOTH_BAND_END = 1.02
/** Metres of sway per metre of hanging height at strength 1 (before the weight, the gust and the flap). */
export const CLOTH_AMP_PER_M = 0.35
/** The largest sway amplitude (m) at strength 1. */
export const CLOTH_AMP_MAX_M = 1
/** A tent's panels billow this fraction of a hanging piece's sway. */
export const CLOTH_TENT_SCALE = 0.6

const F = (v: number): string => v.toFixed(2)

/** WGSL definitions under SRO_CLOTH_WIND (functions the sway needs). */
export const CLOTH_VERTEX_DEFS_WGSL = /* wgsl */ `fn sroClothSway(pv: vec4f, wp: vec3f, z: f32, t: f32) -> vec2f {
  if (pv.z < 0.5) {
    return vec2f(0.0);
  }
  let h = max(pv.y, 0.05);
  let tent = pv.z > 2.5;
  let awn = pv.z > 1.5 && !tent;
  let u = select(pv.x - wp.y, wp.y - pv.x, tent) / h;
  let c = clamp(u, 0.0, 1.0);
  let w = select(c * c * step(u, ${F(CLOTH_BAND_END)}), sin(3.14159265 * c), tent);
  let q = pv.w - wp.y * 2.2 + dot(wp.xz, vec2f(0.9, 0.7));
  let gust = 0.55 + 0.45 * sin(t * 0.7 + pv.w * 0.3);
  let flap = sin(t * 3.1 + q) * 0.35 + sin(t * 5.3 + pv.w * 0.7 + q * 1.7) * 0.12;
  let a = z * min(${F(CLOTH_AMP_PER_M)} * h, ${F(CLOTH_AMP_MAX_M)}) * w * gust * select(1.0, ${F(CLOTH_TENT_SCALE)}, tent);
  let s = a * (0.55 + flap);
  if (awn) {
    return vec2f(0.5 * s, 0.6 * a * flap);
  }
  return vec2f(s, select(0.25 * s * s / h, 0.12 * a * flap, tent));
}
`

/** GLSL definitions under SRO_CLOTH_WIND. */
export const CLOTH_VERTEX_DEFS_GLSL = /* glsl */ `vec2 sroClothSway(vec4 pv, vec3 wp, float z, float t) {
  if (pv.z < 0.5) {
    return vec2(0.0);
  }
  float h = max(pv.y, 0.05);
  bool tent = pv.z > 2.5;
  bool awn = pv.z > 1.5 && !tent;
  float u = (tent ? wp.y - pv.x : pv.x - wp.y) / h;
  float c = clamp(u, 0.0, 1.0);
  float w = tent ? sin(3.14159265 * c) : c * c * step(u, ${F(CLOTH_BAND_END)});
  float q = pv.w - wp.y * 2.2 + dot(wp.xz, vec2(0.9, 0.7));
  float gust = 0.55 + 0.45 * sin(t * 0.7 + pv.w * 0.3);
  float flap = sin(t * 3.1 + q) * 0.35 + sin(t * 5.3 + pv.w * 0.7 + q * 1.7) * 0.12;
  float a = z * min(${F(CLOTH_AMP_PER_M)} * h, ${F(CLOTH_AMP_MAX_M)}) * w * gust * (tent ? ${F(CLOTH_TENT_SCALE)} : 1.0);
  float s = a * (0.55 + flap);
  if (awn) {
    return vec2(0.5 * s, 0.6 * a * flap);
  }
  return vec2(s, tent ? 0.12 * a * flap : 0.25 * s * s / h);
}
`

/** WGSL statements moving `worldPos` (reads `clothPivot`, `uniforms.wxB`, `uniforms.sroFol`). */
export const CLOTH_WORLDPOS_WGSL = /* wgsl */ `#ifdef SRO_FOL_BREEZE
  let clZ = max(clamp(uniforms.wxB.z, 0.0, 1.0), uniforms.sroFol.y);
#else
  let clZ = clamp(uniforms.wxB.z, 0.0, 1.0);
#endif
  let clS = sroClothSway(clothPivot, worldPos.xyz, clZ, uniforms.wxB.w);
  worldPos = vec4f(worldPos.x + uniforms.wxB.x * clS.x, worldPos.y + clS.y, worldPos.z + uniforms.wxB.y * clS.x, worldPos.w);
`

/** GLSL statements moving `worldPos` (reads `clothPivot`, `wxB`, `sroFol`). */
export const CLOTH_WORLDPOS_GLSL = /* glsl */ `#ifdef SRO_FOL_BREEZE
  float clZ = max(clamp(wxB.z, 0.0, 1.0), sroFol.y);
#else
  float clZ = clamp(wxB.z, 0.0, 1.0);
#endif
  vec2 clS = sroClothSway(clothPivot, worldPos.xyz, clZ, wxB.w);
  worldPos.xyz += vec3(wxB.x * clS.x, clS.y, wxB.y * clS.x);
`

/**
 * The chunk's offset in TS (tests, the lab): `pivot` = (pin y, height, kind code, phase) as `clothPivots` writes it,
 * `p` the vertex's world position at rest, `strength` the wind's (or the breeze), `t` the weather clock (`wxB.w`),
 * `wind` the wind direction (`wxB.xy`). Returns the world offset [x, y, z] (m).
 */
export function clothSway(
  pivot: readonly [number, number, number, number],
  p: readonly [number, number, number],
  strength: number,
  t: number,
  wind: readonly [number, number] = [1, 0],
): [number, number, number] {
  const [pin, height, kind, phase] = pivot
  if (kind < 0.5) return [0, 0, 0]
  const h = Math.max(height, 0.05)
  const tent = kind > 2.5
  const awn = kind > 1.5 && !tent
  const u = (tent ? p[1] - pin : pin - p[1]) / h
  const c = Math.min(1, Math.max(0, u))
  const w = tent ? Math.sin(3.14159265 * c) : c * c * (u <= CLOTH_BAND_END ? 1 : 0)
  const q = phase - p[1] * 2.2 + p[0] * 0.9 + p[2] * 0.7
  const gust = 0.55 + 0.45 * Math.sin(t * 0.7 + phase * 0.3)
  const flap = Math.sin(t * 3.1 + q) * 0.35 + Math.sin(t * 5.3 + phase * 0.7 + q * 1.7) * 0.12
  const z = Math.min(1, Math.max(0, strength))
  const a = z * Math.min(CLOTH_AMP_PER_M * h, CLOTH_AMP_MAX_M) * w * gust * (tent ? CLOTH_TENT_SCALE : 1)
  const s = a * (0.55 + flap)
  const [sx, sy] = awn ? [0.5 * s, 0.6 * a * flap] : [s, tent ? 0.12 * a * flap : 0.25 * s * s / h]
  return [wind[0] * sx, sy, wind[1] * sx]
}

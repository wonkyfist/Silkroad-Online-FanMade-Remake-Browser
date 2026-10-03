/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `OceanFFT.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * The GPU FFT's compute kernels (docs/COAST.md §8.3), WGSL only (WebGL2 has no compute; its GLSL twin is the worker
 * tile, fft-core.ts, which these kernels match: tests compare them in the browser bench). Two dispatches per frame for
 * all cascades together:
 *
 * - **rows** (one workgroup per row per cascade): h0 evolved to h̃(k, t) (`h̃ = h0(k) e^{−iωt} + conj(h0(−k)) e^{iωt}`),
 *   eight real fields packed into four complex ones (fft-core.ts's P1..P4), and an N-point radix-2 inverse FFT per
 *   row in workgroup memory, into a scratch buffer;
 * - **columns** (one workgroup per column per cascade): the column IFFTs, the centred-spectrum sign fix, the unpack,
 *   the Jacobian and the persistent foam, written to the output array: layer c = (Dx, Dy, Dz, foam), layer C + c =
 *   (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z);
 * - **mips** (one small dispatch per level for every layer): a 2 × 2 box from level l − 1 to level l, through per-level
 *   views of the same texture (Babylon writes storage textures through a level-0 view only, §8.3 route 1).
 */

/** Uniform block (48 bytes + the cascade tiles and gains): see `rowsWgsl`. */
export const FFT_PARAMS_FLOATS = 16

const PARAMS = `struct Params {
  a: vec4f, // t (s), dt (s), λ, foam bias
  b: vec4f, // N, C, foam decay, foam gain
  tiles: vec4f, // L per cascade
  gains: vec4f, // amplitude gain per cascade
};
`

/** The row pass for an N-point transform (N a power of 2, ≤ 256). */
export function rowsWgsl(n: number): string {
  const bits = Math.log2(n)
  return `${PARAMS}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> h0: array<vec4f>;
@group(0) @binding(2) var<storage, read> omega: array<f32>;
@group(0) @binding(3) var<storage, read_write> scratch: array<vec4f>;

var<workgroup> w1: array<vec2f, ${n}>;
var<workgroup> w2: array<vec2f, ${n}>;
var<workgroup> w3: array<vec2f, ${n}>;
var<workgroup> w4: array<vec2f, ${n}>;

fn rev(i: u32) -> u32 {
  return reverseBits(i) >> ${32 - bits}u;
}

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(${n})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let n = ${n}u;
  let i = lid.x;
  let j = wid.x;
  let c = wid.y;
  let idx = c * n * n + j * n + i;
  let tile = params.tiles[c];
  let dk = 6.283185307179586 / tile;
  let kx = (f32(i) - f32(n / 2u)) * dk;
  let kz = (f32(j) - f32(n / 2u)) * dk;
  let k = length(vec2f(kx, kz));
  var p1 = vec2f(0.0);
  var p2 = vec2f(0.0);
  var p3 = vec2f(0.0);
  var p4 = vec2f(0.0);
  if (i != 0u && j != 0u && k > 1e-6) {
    let hp = h0[idx] * params.gains[c];
    let wt = omega[idx] * params.a.x;
    let cw = cos(wt);
    let sw = sin(wt);
    // h̃ = h0(k) e^{−iωt} + conj(h0(−k)) e^{iωt}
    let hr = hp.x * cw + hp.y * sw + hp.z * cw + hp.w * sw;
    let hi = hp.y * cw - hp.x * sw + hp.z * sw - hp.w * cw;
    let l = params.a.z / k;
    p1 = vec2f(l * (kz * hr + kx * hi), l * (kz * hi - kx * hr));
    let cxz = l * kx * kz;
    p2 = vec2f(hr - cxz * hi, hi + cxz * hr);
    p3 = vec2f(-kz * hr - kx * hi, kx * hr - kz * hi);
    let ax = l * kx * kx;
    let az = l * kz * kz;
    p4 = vec2f(hr * ax - hi * az, hi * ax + hr * az);
  }
  let r = rev(i);
  w1[r] = p1;
  w2[r] = p2;
  w3[r] = p3;
  w4[r] = p4;
  workgroupBarrier();
  for (var size = 2u; size <= n; size = size * 2u) {
    let half = size / 2u;
    if (i < n / 2u) {
      let g = i / half;
      let q = i % half;
      let a = g * size + q;
      let b = a + half;
      let ang = 6.283185307179586 * f32(q) / f32(size);
      let tw = vec2f(cos(ang), sin(ang));
      let x1 = cmul(w1[b], tw);
      w1[b] = w1[a] - x1;
      w1[a] = w1[a] + x1;
      let x2 = cmul(w2[b], tw);
      w2[b] = w2[a] - x2;
      w2[a] = w2[a] + x2;
      let x3 = cmul(w3[b], tw);
      w3[b] = w3[a] - x3;
      w3[a] = w3[a] + x3;
      let x4 = cmul(w4[b], tw);
      w4[b] = w4[a] - x4;
      w4[a] = w4[a] + x4;
    }
    workgroupBarrier();
  }
  scratch[idx * 2u] = vec4f(w1[i], w2[i]);
  scratch[idx * 2u + 1u] = vec4f(w3[i], w4[i]);
}
`
}

/** The column pass: column IFFTs, sign fix, unpack, Jacobian, foam, and the output layers. */
export function colsWgsl(n: number): string {
  const bits = Math.log2(n)
  return `${PARAMS}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> scratch: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> foam: array<f32>;
@group(0) @binding(3) var outTex: texture_storage_2d_array<rgba16float, write>;

var<workgroup> w1: array<vec2f, ${n}>;
var<workgroup> w2: array<vec2f, ${n}>;
var<workgroup> w3: array<vec2f, ${n}>;
var<workgroup> w4: array<vec2f, ${n}>;

fn rev(i: u32) -> u32 {
  return reverseBits(i) >> ${32 - bits}u;
}

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(${n})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let n = ${n}u;
  let j = lid.x;
  let i = wid.x;
  let c = wid.y;
  let src = c * n * n + j * n + i;
  let s0 = scratch[src * 2u];
  let s1 = scratch[src * 2u + 1u];
  let r = rev(j);
  w1[r] = s0.xy;
  w2[r] = s0.zw;
  w3[r] = s1.xy;
  w4[r] = s1.zw;
  workgroupBarrier();
  for (var size = 2u; size <= n; size = size * 2u) {
    let half = size / 2u;
    if (j < n / 2u) {
      let g = j / half;
      let q = j % half;
      let a = g * size + q;
      let b = a + half;
      let ang = 6.283185307179586 * f32(q) / f32(size);
      let tw = vec2f(cos(ang), sin(ang));
      let x1 = cmul(w1[b], tw);
      w1[b] = w1[a] - x1;
      w1[a] = w1[a] + x1;
      let x2 = cmul(w2[b], tw);
      w2[b] = w2[a] - x2;
      w2[a] = w2[a] + x2;
      let x3 = cmul(w3[b], tw);
      w3[b] = w3[a] - x3;
      w3[a] = w3[a] + x3;
      let x4 = cmul(w4[b], tw);
      w4[b] = w4[a] - x4;
      w4[a] = w4[a] + x4;
    }
    workgroupBarrier();
  }
  let sg = select(-1.0, 1.0, ((i + j) & 1u) == 0u);
  let p1 = w1[j] * sg;
  let p2 = w2[j] * sg;
  let p3 = w3[j] * sg;
  let p4 = w4[j] * sg;
  let jxx = p4.x;
  let jzz = p4.y;
  let jxz = p2.y;
  let jac = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
  let inject = clamp((params.a.w - jac) * params.b.w, 0.0, 1.5);
  let fi = c * n * n + j * n + i;
  let fo = max(foam[fi] - params.b.z * params.a.y, inject);
  foam[fi] = fo;
  let cc = u32(params.b.y);
  textureStore(outTex, vec2u(i, j), c, vec4f(p1.x, p2.x, p1.y, fo));
  textureStore(outTex, vec2u(i, j), cc + c, vec4f(p3.x, p3.y, jxx, jzz));
}
`
}

/** One mip level for every layer: a 2 × 2 box from the level above. */
export const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let p = vec2i(gid.xy) * 2;
  let l = i32(gid.z);
  let v = textureLoad(src, p, l, 0) + textureLoad(src, p + vec2i(1, 0), l, 0) + textureLoad(src, p + vec2i(0, 1), l, 0) + textureLoad(src, p + vec2i(1, 1), l, 0);
  textureStore(dst, gid.xy, l, v * 0.25);
}
`

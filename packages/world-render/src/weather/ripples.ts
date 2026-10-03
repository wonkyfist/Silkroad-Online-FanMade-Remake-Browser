/**
 * The rain-ripple texture (docs/WEATHER.md §6.6, docs/WAVE_PLAN3.md D21): one tiling, CPU-generated RGBA8 texture
 * (Lagarde's rain ripples) that serves the Classic terrain puddles, both waters and the PBR plugins
 * (`world.weather.rippleTexture`). Built when the weather level is set (never lazily on the first rain: 256² is a
 * 35–100 ms hitch on a weak laptop), 128² with 60 drops on Low/Medium, 256² with 200 drops on High/Ultra.
 *
 * Texel: R = ring height (128 + 127 × (1 − r / rMax), 128 outside every drop), GB = the radial direction × 127 + 128,
 * A = the drop's time offset 0..255. Shaders sample it two or three times (the second layer × 1.37, offset, half a
 * period later; a third in a downpour) and turn each sample into an expanding ring with the one ring function below
 * (wave 12 RAIN-P, docs/WEATHER.md §6.10: the terrain's rain film and puddles, both waters, the sea, the Classic
 * chunks; `rainCellCode` is its texture-free twin for the object materials).
 */
import { Constants, RawTexture, Texture, type Scene } from '@babylonjs/core'

// ---- the rain rings (wave 12 RAIN-P): one ring function for every consumer ---------------------------------------

/**
 * Ring cycles per second: each drop's ring is born, expands and fades in 1 / RAIN_RING_RATE s (the drop's own phase
 * offset is the texel's A).
 */
export const RAIN_RING_RATE = 1.3
/**
 * Live drops per layer by rain rate: drizzle (rain ≈ 0.2) a sparse quarter of the texture's drops, the `rain` state
 * (0.55) about two thirds, a downpour (≥ 0.85) all of them. `smoothstep(lo, hi, rain)` mapped onto [min, 1].
 */
export const RAIN_RING_DENSITY = { min: 0.12, lo: 0.05, hi: 0.85 } as const
/** A ring's reach (× the drop's footprint) by rain rate: drizzle rings stay small, a downpour's fill the footprint. */
export const RAIN_RING_SIZE = { min: 0.5, lo: 0.1, hi: 0.9 } as const
/** A third, coarser layer joins above this rain rate (a downpour's overlapping rings), full at RAIN_RING_DENSE_FULL. */
export const RAIN_RING_DENSE = 0.6
export const RAIN_RING_DENSE_FULL = 0.9

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The fraction of drops alive at a rain rate (TS mirror of the shader's `on` threshold). */
export function ringDensity(rain: number): number {
  const d = RAIN_RING_DENSITY
  return d.min + (1 - d.min) * smooth(d.lo, d.hi, rain)
}

/** The ring's reach at a rain rate (TS mirror). */
export function ringSize(rain: number): number {
  const s = RAIN_RING_SIZE
  return s.min + (1 - s.min) * smooth(s.lo, s.hi, rain)
}

/**
 * One tap of the ripple texture as a rain ring (TS mirror of `rainRingCode`; texel channels 0..1): returns the normal
 * tilt along the drop's radial direction (x, z), the impact crown (a bright dot in the first instant of a drop) and the
 * ring's signed height (crests +, troughs −: the albedo contrast of the ring lines). `off` is the layer's phase
 * offset, `time` seconds.
 */
export function rainRing(t: readonly [number, number, number, number], off: number, time: number, rain: number): [number, number, number, number] {
  const fr = (v: number) => v - Math.floor(v)
  const ph = fr(t[3] + time * RAIN_RING_RATE + off)
  const on = fr(t[3] * 158.13 + off * 3.7) <= ringDensity(rain) ? 1 : 0
  const s = ringSize(rain)
  const d = 2 - 2 * t[0]
  const x = Math.min(Math.max(((ph * s - d) * 20) / s, 0), 9.424778)
  const h = Math.sin(x) * (1 - ph * ph) * on
  const c = (1 - smooth(0, 0.3, d)) * (1 - smooth(0, 0.15, ph)) * on
  return [(t[1] * 2 - 1) * h, (t[2] * 2 - 1) * h, c, h]
}

const n3 = (v: number) => v.toFixed(3)

/**
 * The ring function in a shader language, named `name` (each material declares its own copy under its own prefix:
 * no two plugins on one material share a function name). `fn name(t, off, tm, rain) -> vec4`: t = the ripple texel
 * (R = 1 − r / rMax, GB = the radial direction, A = the drop's phase), off = the layer's phase offset, tm = time (s),
 * rain = the rain rate 0..1. Returns (tilt x, tilt z, crown, height), the same as `rainRing`.
 */
export function rainRingCode(lang: 'wgsl' | 'glsl', name: string): string {
  const D = RAIN_RING_DENSITY, S = RAIN_RING_SIZE
  const dens = `mix(${n3(D.min)}, 1.0, smoothstep(${n3(D.lo)}, ${n3(D.hi)}, rain))`
  const size = `mix(${n3(S.min)}, 1.0, smoothstep(${n3(S.lo)}, ${n3(S.hi)}, rain))`
  if (lang === 'wgsl') {
    return `fn ${name}(t: vec4f, off: f32, tm: f32, rain: f32) -> vec4f {
  let ph = fract(t.a + tm * ${n3(RAIN_RING_RATE)} + off);
  let on = step(fract(t.a * 158.13 + off * 3.7), ${dens});
  let s = ${size};
  let d = 2.0 - 2.0 * t.r;
  let h = sin(clamp((ph * s - d) * 20.0 / s, 0.0, 9.424778)) * (1.0 - ph * ph) * on;
  let c = (1.0 - smoothstep(0.0, 0.3, d)) * (1.0 - smoothstep(0.0, 0.15, ph)) * on;
  return vec4f((t.gb * 2.0 - vec2f(1.0)) * h, c, h);
}
`
  }
  return `vec4 ${name}(vec4 t, float off, float tm, float rain) {
  float ph = fract(t.a + tm * ${n3(RAIN_RING_RATE)} + off);
  float on = step(fract(t.a * 158.13 + off * 3.7), ${dens});
  float s = ${size};
  float d = 2.0 - 2.0 * t.r;
  float h = sin(clamp((ph * s - d) * 20.0 / s, 0.0, 9.424778)) * (1.0 - ph * ph) * on;
  float c = (1.0 - smoothstep(0.0, 0.3, d)) * (1.0 - smoothstep(0.0, 0.15, ph)) * on;
  return vec4((t.gb * 2.0 - vec2(1.0)) * h, c, h);
}
`
}

/**
 * The texture-free ring field (for materials that cannot spare a sampler: the PBR objects' SroSurfacePlugin), in a
 * shader language: `fn name(p, tm, rain) -> vec4` with `p` in cell units. One drop per cell at a hashed spot in the
 * cell's middle half, its own phase and live hash; a ring reaches at most half a cell, so the 2 × 2 cells around `p`
 * hold every drop that can touch it. The same ring profile, rate, density and size as `rainRingCode`; returns (tilt x,
 * tilt z, crown, height). `hash` is a sine-free `vec2 → float` hash the material already declares.
 */
export function rainCellCode(lang: 'wgsl' | 'glsl', name: string, hash: string): string {
  const D = RAIN_RING_DENSITY, S = RAIN_RING_SIZE
  const dens = `mix(${n3(D.min)}, 1.0, smoothstep(${n3(D.lo)}, ${n3(D.hi)}, rain))`
  const size = `mix(${n3(S.min)}, 1.0, smoothstep(${n3(S.lo)}, ${n3(S.hi)}, rain))`
  if (lang === 'wgsl') {
    return `fn ${name}(p: vec2f, tm: f32, rain: f32) -> vec4f {
  let b = floor(p - vec2f(0.5));
  let dens = ${dens};
  let s = ${size};
  var acc = vec4f(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let c = b + vec2f(f32(i), f32(j));
      let d = p - c - vec2f(0.25) - vec2f(${hash}(c), ${hash}(c + vec2f(17.3, 5.1))) * 0.5;
      let l = max(length(d), 1e-4);
      let r = l * 2.0;
      let ph = fract(${hash}(c + vec2f(3.7, 29.9)) + tm * ${n3(RAIN_RING_RATE)});
      let on = step(${hash}(c + vec2f(41.1, 11.7)), dens);
      let h = sin(clamp((ph * s - r) * 20.0 / s, 0.0, 9.424778)) * (1.0 - ph * ph) * on;
      let cr = (1.0 - smoothstep(0.0, 0.3, r)) * (1.0 - smoothstep(0.0, 0.15, ph)) * on;
      acc = acc + vec4f(d / l * h, cr, h);
    }
  }
  return acc;
}
`
  }
  return `vec4 ${name}(vec2 p, float tm, float rain) {
  vec2 b = floor(p - vec2(0.5));
  float dens = ${dens};
  float s = ${size};
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 c = b + vec2(float(i), float(j));
      vec2 d = p - c - vec2(0.25) - vec2(${hash}(c), ${hash}(c + vec2(17.3, 5.1))) * 0.5;
      float l = max(length(d), 1e-4);
      float r = l * 2.0;
      float ph = fract(${hash}(c + vec2(3.7, 29.9)) + tm * ${n3(RAIN_RING_RATE)});
      float on = step(${hash}(c + vec2(41.1, 11.7)), dens);
      float h = sin(clamp((ph * s - r) * 20.0 / s, 0.0, 9.424778)) * (1.0 - ph * ph) * on;
      float cr = (1.0 - smoothstep(0.0, 0.3, r)) * (1.0 - smoothstep(0.0, 0.15, ph)) * on;
      acc += vec4(d / l * h, cr, h);
    }
  }
  return acc;
}
`
}

/**
 * The implicit-LOD taps' mip bias: a ring is a few texels wide, so the texture's mips (which average the drops' phases
 * and radii away) erase the rings a few metres out; two levels sharper keep them to gameplay distance, and the
 * consumers fade them out by distance before the aliasing shows.
 */
export const RAIN_RING_LOD_BIAS = -2

/** The three layers' uv scale, offset and phase offset (the third only above RAIN_RING_DENSE). */
export const RAIN_RING_LAYERS = [
  { scale: 1, offset: [0, 0], phase: 0 },
  { scale: 1.37, offset: [0.31, 0.57], phase: 0.5 },
  { scale: 0.73, offset: [0.61, 0.13], phase: 0.25 },
] as const

/**
 * The taps of the three ring layers, summed into `out` (declared here, a vec4: tilt x, tilt z, crown, height).
 * - With `dx`/`dy` (gradient taps, any control flow): the third layer sits in a uniform branch on the rain rate.
 * - Without them (implicit-LOD taps biased by `bias`, uniform control flow only, no branch around the taps): all
 *   three taps always run, the third weighted by the same smoothstep (0 below RAIN_RING_DENSE).
 * `tex` is the sampler's name (WGSL: `${tex}Sampler` beside it).
 */
export function ringTaps(lang: 'wgsl' | 'glsl', fn: string, tex: string, uv: string, dx: string | null, dy: string | null, tm: string, rain: string, out: string, indent = '  ', bias = RAIN_RING_LOD_BIAS): string {
  const w = lang === 'wgsl'
  const V2 = w ? 'vec2f' : 'vec2'
  const tap = (i: number) => {
    const l = RAIN_RING_LAYERS[i]!
    const u = l.scale === 1 ? uv : `${uv} * ${n3(l.scale)} + ${V2}(${n3(l.offset[0])}, ${n3(l.offset[1])})`
    const g = (d: string) => (l.scale === 1 ? d : `${d} * ${n3(l.scale)}`)
    const t = dx && dy
      ? (w ? `textureSampleGrad(${tex}, ${tex}Sampler, ${u}, ${g(dx)}, ${g(dy)})` : `textureGrad(${tex}, ${u}, ${g(dx)}, ${g(dy)})`)
      : (w ? `textureSampleBias(${tex}, ${tex}Sampler, ${u}, ${n3(bias)})` : `texture(${tex}, ${u}, ${n3(bias)})`)
    return `${fn}(${t}, ${n3(l.phase)}, ${tm}, ${rain})`
  }
  const dense = `smoothstep(${n3(RAIN_RING_DENSE)}, ${n3(RAIN_RING_DENSE_FULL)}, ${rain})`
  const decl = w ? `var ${out} = ` : `vec4 ${out} = `
  if (dx && dy) {
    return `${indent}${decl}${tap(0)} + ${tap(1)};\n` +
      `${indent}if (${rain} > ${n3(RAIN_RING_DENSE)}) {\n` +
      `${indent}  ${out} = ${out} + ${tap(2)} * ${dense};\n` +
      `${indent}}\n`
  }
  return `${indent}${decl}${tap(0)} + ${tap(1)} + ${tap(2)} * ${dense};\n`
}

/** The ripple pixels (RGBA8, size², tiling), deterministic for a seed. */
export function ripplePixels(size: number, drops: number, seed = 1): Uint8Array<ArrayBuffer> {
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296)
  const tex = new Uint8Array(size * size * 4)
  for (let i = 0; i < tex.length; i += 4) {
    tex[i] = 128
    tex[i + 1] = 128
    tex[i + 2] = 128
    tex[i + 3] = 0
  }
  const maxR = size * 0.09
  const span = Math.ceil(maxR)
  for (let d = 0; d < drops; d++) {
    const cx = rnd() * size, cz = rnd() * size, phase = rnd()
    for (let z = -span; z <= span; z++) {
      for (let x = -span; x <= span; x++) {
        const r = Math.hypot(x, z) / maxR
        if (r > 1) continue
        const px = ((Math.floor(cx + x) % size) + size) % size
        const pz = ((Math.floor(cz + z) % size) + size) % size
        const o = (pz * size + px) * 4
        const fall = 1 - r
        // A nearer drop centre wins the texel (the rings do not overlap in one layer).
        if (fall * 127 <= tex[o]! - 128) continue
        tex[o] = 128 + Math.round(127 * fall)
        tex[o + 1] = 128 + Math.round(127 * (r > 0 ? x / (r * maxR) : 0))
        tex[o + 2] = 128 + Math.round(127 * (r > 0 ? z / (r * maxR) : 0))
        tex[o + 3] = Math.round(255 * phase)
      }
    }
  }
  return tex
}

/** Drops per texture size (WEATHER §6.6). */
export function rippleDrops(size: number): number {
  return size >= 256 ? 200 : 60
}

/** The ripple texture for a weather level's size (mipmapped, repeating). */
export function createRippleTexture(scene: Scene, size: 128 | 256): RawTexture {
  const tex = new RawTexture(ripplePixels(size, rippleDrops(size)), size, size, Constants.TEXTUREFORMAT_RGBA, scene, true, false,
    Texture.TRILINEAR_SAMPLINGMODE)
  tex.name = `wxRipples${size}`
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  return tex
}

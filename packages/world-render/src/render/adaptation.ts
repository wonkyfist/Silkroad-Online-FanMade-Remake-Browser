/**
 * Eye adaptation (docs/LIGHTING.md §2): a bounded, GPU-only auto exposure on top of the sky's designed exposure
 * (SkyState.exposure × EXPOSURE_TRIM, the "key" of each time of day). The sky's exposure stays the anchor, so the
 * look the time of day was tuned for is kept; the adaptation only corrects what the sky cannot know: the camera in a
 * dark gate passage, under a forest roof or inside a lantern-lit street at night opens up (≤ +ADAPT.maxUpEV), a view
 * full of bright sky or snow closes down (≤ −ADAPT.maxDownEV). Partial (strength < 1), as in AAA games: a dark place
 * still reads darker than a sunlit one.
 *
 *   meter (the scene target → 32 × 18 log-luminance) ──► adapt (→ 1 × 1, temporal, ping-pong)   every 2nd frame
 *   apply: scene × 2^ev in the shafts' full-resolution composite (no pass of its own), or its own pass without shafts
 *
 * The meter and the adapt run outside the camera's post chain (EffectRenderer, after the frame, every ADAPT_EVERY
 * frames: two tiny draws; three chained post-processes cost ~0.5 ms of CPU on Medium). The apply sits in the HDR chain
 * before the default pipeline, so bloom and the tone map see the adapted image (one frame late: invisible). No
 * readback: the correction lives in a 1 × 1 half-float target; `readState()` reads it back for the lab and the tests
 * only. The pure parts (key, target, temporal step) mirror the shader (test/lighting-aaa.test.ts).
 */
import {
  Constants,
  EffectRenderer,
  EffectWrapper,
  PostProcess,
  RawTexture,
  ShaderLanguage,
  ShaderStore,
  Texture,
  type Camera,
  type Effect,
  type InternalTexture,
  type Nullable,
  type RenderTargetWrapper,
  type Scene,
} from '@babylonjs/core'
import { addWarmupHook } from '../warmup-hooks.ts'

export interface AdaptTuning {
  /** Share of the measured deviation that is corrected (0 = none, 1 = full normalisation). */
  strength: number
  /** Deviations from the key up to this (EV) are left alone (presets and views differ a little; only clear cases adapt). */
  deadZoneEV: number
  /** Most the image opens up / closes down (EV). */
  maxUpEV: number
  maxDownEV: number
  /** log2 of the target mean exposed luminance (scene-linear × the designed exposure) by day, at night. */
  keyDay: number
  keyNight: number
  /** The key drops this far (EV) in a full storm (overcast + rain): a storm stays dark, the eye does not undo it. */
  stormKeyEV: number
  /** Extra brightening at night (EV) beyond what the night key asks: the night must read, not be murky. */
  nightLiftEV: number
  /** Time constants (s): opening up (dark adaptation, slow) and closing down (fast). */
  tauUp: number
  tauDown: number
  /** Centre weighting of the meter: the border's weight against 1 at the centre. */
  edgeWeight: number
}

/**
 * Tuned on the bench scenes (docs/LIGHTING.md §2): the keys are the measured mean log2 exposed luminance of the Jangan
 * plaza at noon and at 21:30 (open views, which are therefore left as the sky designed them).
 */
export const ADAPT: Readonly<AdaptTuning> = {
  strength: 0.65,
  deadZoneEV: 0.35,
  maxUpEV: 1.1,
  maxDownEV: 0.6,
  keyDay: -2.8,
  keyNight: -4,
  stormKeyEV: 1.2,
  nightLiftEV: 0.25,
  tauUp: 1.6,
  tauDown: 0.6,
  edgeWeight: 0.35,
}

/** Meter resolution (the adapt pass reads every texel). */
export const METER_W = 32
export const METER_H = 18

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** How stormy the weather is for the key (0 clear … 1 overcast with full rain). */
export function storminess(w: { cloud: number; rain: number } | null | undefined): number {
  if (!w) return 0
  return clamp01(Math.max(clamp01(w.rain), smoothstep(0.5, 1, w.cloud) * 0.7))
}

/** The key (log2 target) at a sun elevation (day above +4°, night below −6°) and a storminess (0–1). */
export function adaptKey(sunElevationDeg: number, storm = 0, t: Readonly<AdaptTuning> = ADAPT): number {
  const day = smoothstep(-6, 4, sunElevationDeg)
  return t.keyNight + (t.keyDay - t.keyNight) * day - t.stormKeyEV * clamp01(storm)
}

/** The night lift (EV) at a sun elevation. */
export function nightLift(sunElevationDeg: number, t: Readonly<AdaptTuning> = ADAPT): number {
  return t.nightLiftEV * (1 - smoothstep(-6, 4, sunElevationDeg))
}

/** The correction (EV) a measured mean log2 exposed luminance asks for (the shader's `tgt`). */
export function adaptTargetEV(meanLog2: number, key: number, lift = 0, t: Readonly<AdaptTuning> = ADAPT): number {
  if (!Number.isFinite(meanLog2)) return 0
  const d = key - meanLog2
  const dz = Math.sign(d) * Math.max(Math.abs(d) - t.deadZoneEV, 0)
  return Math.min(t.maxUpEV, Math.max(-t.maxDownEV, t.strength * dz + lift))
}

/** One temporal step from `prev` towards `target` (EV) over dt seconds (the shader's blend). */
export function adaptStep(prev: number, tgt: number, dt: number, t: Readonly<AdaptTuning> = ADAPT): number {
  const tau = tgt > prev ? t.tauUp : t.tauDown
  const k = 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-3, tau))
  return prev + (tgt - prev) * k
}

// ---- shaders ---------------------------------------------------------------------------------------------------------

export const ADAPT_METER_SHADER = 'sroAdaptMeter'
export const ADAPT_ADAPT_SHADER = 'sroAdaptAdapt'
export const ADAPT_APPLY_SHADER = 'sroAdaptApply'

const METER_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform sroMeter: vec4f;

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let cell = vec2f(1.0 / ${METER_W}.0, 1.0 / ${METER_H}.0);
  let o = fragmentInputs.vUV - 0.5 * cell;
  var s = 0.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let uv = o + (vec2f(f32(i), f32(j)) + 0.5) * 0.25 * cell;
      let c = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0).rgb;
      let l = dot(c, vec3f(0.2126, 0.7152, 0.0722)) * uniforms.sroMeter.x;
      s += log2(clamp(l, 1e-4, 64.0));
    }
  }
  fragmentOutputs.color = vec4f(s / 16.0, 0.0, 0.0, 1.0);
}
`

const METER_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform highp sampler2D textureSampler;
uniform vec4 sroMeter;

#define CUSTOM_FRAGMENT_DEFINITIONS

void main(void) {
  vec2 cell = vec2(1.0 / ${METER_W}.0, 1.0 / ${METER_H}.0);
  vec2 o = vUV - 0.5 * cell;
  float s = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 uv = o + (vec2(float(i), float(j)) + 0.5) * 0.25 * cell;
      vec3 c = textureLod(textureSampler, uv, 0.0).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) * sroMeter.x;
      s += log2(clamp(l, 1e-4, 64.0));
    }
  }
  gl_FragColor = vec4(s / 16.0, 0.0, 0.0, 1.0);
}
`

// sroAdapt: key, strength, maxUp, maxDown; sroAdaptTime: dt, tauUp, tauDown, reset; sroAdaptMore: lift, edgeWeight, on, dead zone
const ADAPT_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var sroHistorySampler: sampler;
var sroHistory: texture_2d<f32>;
uniform sroAdapt: vec4f;
uniform sroAdaptTime: vec4f;
uniform sroAdaptMore: vec4f;

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  var s = 0.0;
  var ws = 0.0;
  for (var y = 0; y < ${METER_H}; y++) {
    for (var x = 0; x < ${METER_W}; x++) {
      let p = (vec2f(f32(x), f32(y)) + 0.5) / vec2f(${METER_W}.0, ${METER_H}.0) * 2.0 - 1.0;
      let w = mix(1.0, uniforms.sroAdaptMore.y, clamp(dot(p, p) * 0.5, 0.0, 1.0));
      s += textureLoad(textureSampler, vec2i(x, y), 0).r * w;
      ws += w;
    }
  }
  let mean = s / max(ws, 1e-4);
  let dev = uniforms.sroAdapt.x - mean;
  let dz = sign(dev) * max(abs(dev) - uniforms.sroAdaptMore.w, 0.0);
  let tgt = clamp(uniforms.sroAdapt.y * dz + uniforms.sroAdaptMore.x, -uniforms.sroAdapt.w, uniforms.sroAdapt.z) * uniforms.sroAdaptMore.z;
  let prev = textureLoad(sroHistory, vec2i(0, 0), 0).r;
  let tau = select(uniforms.sroAdaptTime.z, uniforms.sroAdaptTime.y, tgt > prev);
  let k = 1.0 - exp(-max(uniforms.sroAdaptTime.x, 0.0) / max(tau, 1e-3));
  var ev = prev + (tgt - prev) * k;
  if (uniforms.sroAdaptTime.w > 0.5 || !(abs(prev) < 8.0)) {
    ev = tgt;
  }
  fragmentOutputs.color = vec4f(ev, mean, tgt, 1.0);
}
`

const ADAPT_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform highp sampler2D textureSampler;
uniform highp sampler2D sroHistory;
uniform vec4 sroAdapt;
uniform vec4 sroAdaptTime;
uniform vec4 sroAdaptMore;

#define CUSTOM_FRAGMENT_DEFINITIONS

void main(void) {
  float s = 0.0;
  float ws = 0.0;
  for (int y = 0; y < ${METER_H}; y++) {
    for (int x = 0; x < ${METER_W}; x++) {
      vec2 p = (vec2(float(x), float(y)) + 0.5) / vec2(${METER_W}.0, ${METER_H}.0) * 2.0 - 1.0;
      float w = mix(1.0, sroAdaptMore.y, clamp(dot(p, p) * 0.5, 0.0, 1.0));
      s += texelFetch(textureSampler, ivec2(x, y), 0).r * w;
      ws += w;
    }
  }
  float mean = s / max(ws, 1e-4);
  float dev = sroAdapt.x - mean;
  float dz = sign(dev) * max(abs(dev) - sroAdaptMore.w, 0.0);
  float tgt = clamp(sroAdapt.y * dz + sroAdaptMore.x, -sroAdapt.w, sroAdapt.z) * sroAdaptMore.z;
  float prev = texelFetch(sroHistory, ivec2(0), 0).r;
  float tau = tgt > prev ? sroAdaptTime.y : sroAdaptTime.z;
  float k = 1.0 - exp(-max(sroAdaptTime.x, 0.0) / max(tau, 1e-3));
  float ev = prev + (tgt - prev) * k;
  if (sroAdaptTime.w > 0.5 || !(abs(prev) < 8.0)) ev = tgt;
  gl_FragColor = vec4(ev, mean, tgt, 1.0);
}
`

const APPLY_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var sroAdaptTex: texture_2d<f32>;

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let ev = textureLoad(sroAdaptTex, vec2i(0, 0), 0).r;
  let c = textureSampleLevel(textureSampler, textureSamplerSampler, fragmentInputs.vUV, 0.0);
  fragmentOutputs.color = vec4f(c.rgb * exp2(clamp(ev, -4.0, 4.0)), c.a);
}
`

const APPLY_GLSL = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform highp sampler2D sroAdaptTex;

#define CUSTOM_FRAGMENT_DEFINITIONS

void main(void) {
  float ev = texelFetch(sroAdaptTex, ivec2(0), 0).r;
  vec4 c = textureLod(textureSampler, vUV, 0.0);
  gl_FragColor = vec4(c.rgb * exp2(clamp(ev, -4.0, 4.0)), c.a);
}
`

interface AdaptShader { name: string; wgsl: string; glsl: string; uniforms: string[]; samplers: string[] }
export const ADAPT_SHADERS: Readonly<Record<'meter' | 'adapt' | 'apply', AdaptShader>> = {
  meter: { name: ADAPT_METER_SHADER, wgsl: METER_WGSL, glsl: METER_GLSL, uniforms: ['sroMeter'], samplers: ['textureSampler'] },
  adapt: { name: ADAPT_ADAPT_SHADER, wgsl: ADAPT_WGSL, glsl: ADAPT_GLSL, uniforms: ['sroAdapt', 'sroAdaptTime', 'sroAdaptMore'], samplers: ['textureSampler', 'sroHistory'] },
  apply: { name: ADAPT_APPLY_SHADER, wgsl: APPLY_WGSL, glsl: APPLY_GLSL, uniforms: [], samplers: ['sroAdaptTex'] },
}

/** The meter and the adapt run every this many frames (the blend uses the elapsed time). */
export const ADAPT_EVERY = 2

function registerShaders(): void {
  for (const s of Object.values(ADAPT_SHADERS)) {
    const key = `${s.name}FragmentShader`
    if (ShaderStore.ShadersStore[key] !== s.glsl) ShaderStore.ShadersStore[key] = s.glsl
    if (ShaderStore.ShadersStoreWGSL[key] !== s.wgsl) ShaderStore.ShadersStoreWGSL[key] = s.wgsl
  }
}

export interface EyeAdaptationOptions {
  /** Build an apply pass of its own (no shafts' composite to carry the correction). */
  applyPass: boolean
  /** MSAA samples of the apply pass's input (set where it is the camera's first post-process). */
  samples?: number
}

/** What the adaptation did last (readState; the lab and the tests). */
export interface AdaptState {
  ev: number
  meanLog2: number
  target: number
  /** CPU ms of the last metering (every ADAPT_EVERY frames). */
  tickMs: number
}

/** Babylon 9.28 internals: the camera's first live post-process. */
interface FirstPostProcess {
  _getFirstPostProcess?(): Nullable<PostProcess>
}

/**
 * The adaptation on one camera (RenderPost builds it with the shafts, or with its own apply pass after them). Per
 * frame RenderPost calls `setFrame` with the designed exposure, the sun's elevation and the weather.
 */
export class EyeAdaptation {
  /** The apply pass of its own (null: the shafts' composite applies the correction, `bindApply`). */
  readonly apply: PostProcess | null
  tuning: Readonly<AdaptTuning> = ADAPT
  /** false: the correction is 0 (a live A/B; RenderPost rebuilds to drop the passes). */
  enabled = true
  private exposure = 1
  private sunElevationDeg = 45
  private storm = 0
  private readonly renderer: EffectRenderer
  private readonly meterFx: EffectWrapper
  private readonly adaptFx: EffectWrapper
  private meterRt: RenderTargetWrapper | null = null
  private ping: RenderTargetWrapper | null = null
  private pong: RenderTargetWrapper | null = null
  /** The last written 1 × 1 (the apply reads it); `write` takes the next update. */
  private read: RenderTargetWrapper | null = null
  private write: RenderTargetWrapper | null = null
  private zero: RawTexture | null = null
  private source: InternalTexture | null = null
  private frame = 0
  private elapsed = 0
  /** CPU time of the last metering (ms; the lab reads it). */
  tickMs = 0
  private historyValid = false
  private resetNext = true
  private readonly observers: Array<() => void> = []
  private disposed = false

  constructor(readonly scene: Scene, readonly camera: Camera, opts: EyeAdaptationOptions) {
    registerShaders()
    const engine = scene.getEngine()
    const lang = engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL
    this.renderer = new EffectRenderer(engine)
    const fx = (s: AdaptShader) =>
      new EffectWrapper({ engine, name: s.name, fragmentShader: s.name, useShaderStore: true, uniformNames: [...s.uniforms], samplerNames: [...s.samplers], shaderLanguage: lang })
    this.meterFx = fx(ADAPT_SHADERS.meter)
    this.adaptFx = fx(ADAPT_SHADERS.adapt)
    this.meterFx.onApplyObservable.add(() => {
      const e = this.meterFx.effect
      if (this.source) e._bindTexture('textureSampler', this.source)
      e.setFloat4('sroMeter', this.exposure, 0, 0, 0)
    })
    this.adaptFx.onApplyObservable.add(() => this.bindAdapt(this.adaptFx.effect))
    this.apply = opts.applyPass
      ? new PostProcess(ADAPT_SHADERS.apply.name, ADAPT_SHADERS.apply.name, {
          uniforms: [],
          samplers: [...ADAPT_SHADERS.apply.samplers],
          size: 1,
          camera,
          engine,
          samplingMode: Texture.BILINEAR_SAMPLINGMODE,
          textureType: Constants.TEXTURETYPE_HALF_FLOAT,
          shaderLanguage: lang,
        })
      : null
    const apply = this.apply
    if (apply) {
      apply.samples = Math.max(1, opts.samples ?? 1)
      const ob = apply.onApplyObservable.add((e: Effect) => this.bindApply(e, 'sroAdaptTex'))
      this.observers.push(() => apply.onApplyObservable.remove(ob))
    }
    const after = scene.onAfterRenderObservable.add(() => this.tick())
    this.observers.push(() => scene.onAfterRenderObservable.remove(after))
    this.observers.push(addWarmupHook(scene, () => this.disposed || this.isReady()))
  }

  isReady(): boolean {
    return this.meterFx.isReady() && this.adaptFx.isReady() && (this.apply?.isReady() ?? true)
  }

  /** The passes in the camera's chain (the own apply pass, or none). */
  get postProcesses(): readonly PostProcess[] {
    return this.apply ? [this.apply] : []
  }

  /** Per frame: the designed exposure the post applies after this (scene → exposed), the sun's elevation, the weather. */
  setFrame(exposure: number, sunElevationDeg: number, weather?: { cloud: number; rain: number } | null): void {
    this.exposure = Math.max(1e-4, exposure)
    this.sunElevationDeg = sunElevationDeg
    this.storm = storminess(weather)
  }

  /** The next update adapts at once (a teleport, a time jump). */
  reset(): void {
    this.resetNext = true
  }

  /** Binds the current correction (1 × 1, ev in r) to sampler `name` of an effect (the apply, the shafts' composite). */
  bindApply(e: Effect, name: string): void {
    const t = this.historyValid && this.enabled ? this.read?.texture : null
    if (t) e._bindTexture(name, t)
    else e.setTexture(name, this.zeroTexture())
  }

  private zeroTexture(): RawTexture {
    if (!this.zero) {
      this.zero = RawTexture.CreateRGBATexture(new Float32Array(4), 1, 1, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT)
      this.zero.name = 'sroAdaptZero'
    }
    return this.zero
  }

  /** The texture the camera rendered the scene into this frame (the first post-process's input). */
  private sceneTexture(): InternalTexture | null {
    const first = (this.camera as unknown as FirstPostProcess)._getFirstPostProcess?.()
    if (!first) return null
    const pp = first as unknown as { _forcedOutputTexture: Nullable<RenderTargetWrapper> }
    return (pp._forcedOutputTexture ?? first.inputTexture)?.texture ?? null
  }

  private targets(): void {
    if (this.meterRt && this.ping && this.pong) return
    const engine = this.scene.getEngine()
    const opts = (label: string) => ({
      generateMipMaps: false,
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      type: Constants.TEXTURETYPE_HALF_FLOAT,
      format: Constants.TEXTUREFORMAT_RGBA,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
      label,
    })
    this.meterRt = engine.createRenderTargetTexture({ width: METER_W, height: METER_H }, opts('sroAdaptMeter'))
    this.ping = engine.createRenderTargetTexture({ width: 1, height: 1 }, opts('sroAdaptA'))
    this.pong = engine.createRenderTargetTexture({ width: 1, height: 1 }, opts('sroAdaptB'))
    this.read = this.pong
    this.write = this.ping
    this.historyValid = false
  }

  /** After the frame: every ADAPT_EVERY frames, meter the scene and step the adaptation (two tiny draws). */
  private tick(): void {
    if (this.disposed) return
    this.elapsed += Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000))
    if (++this.frame % ADAPT_EVERY !== 0 || !this.meterFx.isReady() || !this.adaptFx.isReady()) return
    const src = this.sceneTexture()
    if (!src) return
    const t0 = performance.now()
    this.targets()
    this.source = src
    this.renderer.render(this.meterFx, this.meterRt)
    this.renderer.render(this.adaptFx, this.write)
    this.source = null
    this.elapsed = 0
    this.historyValid = true
    this.resetNext = false
    const r = this.read
    this.read = this.write
    this.write = r
    this.tickMs = performance.now() - t0
  }

  private bindAdapt(e: Effect): void {
    const t = this.tuning
    const reset = this.resetNext || !this.historyValid
    if (this.meterRt?.texture) e._bindTexture('textureSampler', this.meterRt.texture)
    if (this.read?.texture) e._bindTexture('sroHistory', this.read.texture)
    e.setFloat4('sroAdapt', adaptKey(this.sunElevationDeg, this.storm, t), t.strength, t.maxUpEV, t.maxDownEV)
    e.setFloat4('sroAdaptTime', Math.min(0.5, this.elapsed), t.tauUp, t.tauDown, reset ? 1 : 0)
    e.setFloat4('sroAdaptMore', nightLift(this.sunElevationDeg, t), t.edgeWeight, this.enabled ? 1 : 0, t.deadZoneEV)
  }

  /** Reads the last state back (async; the lab and tests only, never per frame). */
  async readState(): Promise<AdaptState | null> {
    const tex = this.read?.texture
    if (!tex || !this.historyValid) return null
    const engine = this.scene.getEngine() as unknown as { _readTexturePixels(t: unknown, w: number, h: number): Promise<ArrayBufferView> }
    const px = await engine._readTexturePixels(tex, 1, 1)
    const f = px instanceof Float32Array ? px : px instanceof Uint16Array ? Float32Array.from(px, halfToFloat) : null
    if (!f) return null
    return { ev: f[0]!, meanLog2: f[1]!, target: f[2]!, tickMs: this.tickMs }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.observers.splice(0)) off()
    this.apply?.dispose(this.camera)
    this.meterFx.dispose()
    this.adaptFx.dispose()
    this.renderer.dispose()
    this.meterRt?.dispose()
    this.ping?.dispose()
    this.pong?.dispose()
    this.zero?.dispose()
    this.meterRt = this.ping = this.pong = this.read = this.write = null
    this.zero = null
  }
}

function halfToFloat(h: number): number {
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  const s = h & 0x8000 ? -1 : 1
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

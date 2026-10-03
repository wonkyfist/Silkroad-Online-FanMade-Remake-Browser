/**
 * Guards against GPU-side failures that drop a draw or a whole frame without an exception (W9F "blackframe" lens).
 *
 * - **Link settle (WebGL2, BF-1).** Under KHR_parallel_shader_compile, ANGLE drew a newly linked program's first
 *   draws against uniform buffers it judged "too small" (GL_INVALID_OPERATION, the draw becomes a no-op: a missing
 *   mesh for a frame), in bursts past Chrome's 256-message console cap, on world entry and on every live switch.
 *   Every buffer was large enough in the steady state, and one synchronous query of the program's uniform-block sizes
 *   at the first draw made the burst disappear: a race between the parallel link and the first draw.
 *   `installLinkSettle` makes that query once per program, right when Babylon sees the link complete (before the
 *   effect is marked ready, so before any draw with it). Cost: two or three GL queries per new program, once.
 * - **Inter-stage budget (WebGPU, BF-2).** Chrome counts `front_facing` (which every PBR fragment reads),
 *   `sample_index` and `sample_mask` against `maxInterStageShaderVariables` on top of the user varyings. A lit PBR
 *   CSM receiver on a 16-varying adapter already sits at 15 + front_facing = 16; one more varying (a vertex colour,
 *   Babylon fog next to the height fog, tangents, a clip plane) makes the pipeline invalid, and WebGPU then drops the
 *   whole command buffer: a frozen or black frame, not a missing mesh. `installVaryingBudgetCheck` (dev) warns once
 *   per shader before its pipeline is created. Treat 16 as full.
 * - **GL error probe (dev, BF-1).** `installGlErrorProbe` wraps the draw calls and reads getError after each, so the
 *   number of dropped draws is measurable beyond the console cap. It stalls the pipeline: dev only.
 */
import { Effect, ThinEngine, type AbstractEngine } from '@babylonjs/core'

// ---- link settle (WebGL2) -------------------------------------------------------------------------------------------

let settleInstalled = false
const settled = new WeakSet<object>()

interface GlPipeline {
  program?: WebGLProgram | null
  context?: WebGL2RenderingContext | WebGLRenderingContext | null
}

/** Reads every uniform block's data size of a linked program once (forces ANGLE to resolve the link). */
export function settleProgram(gl: WebGL2RenderingContext | WebGLRenderingContext, program: WebGLProgram): number {
  const gl2 = gl as WebGL2RenderingContext
  if (typeof gl2.getActiveUniformBlockParameter !== 'function' || gl2.ACTIVE_UNIFORM_BLOCKS === undefined) return 0
  const blocks = Number(gl2.getProgramParameter(program, gl2.ACTIVE_UNIFORM_BLOCKS)) || 0
  let bytes = 0
  for (let i = 0; i < blocks; i++) bytes += Number(gl2.getActiveUniformBlockParameter(program, i, gl2.UNIFORM_BLOCK_DATA_SIZE)) || 0
  return bytes
}

/** Installs the link settle on every WebGL engine of the page (idempotent; no-op for WebGPU). */
export function installLinkSettle(): void {
  if (settleInstalled) return
  settleInstalled = true
  const proto = ThinEngine.prototype as unknown as { _isRenderingStateCompiled(ctx: GlPipeline): boolean; _gl?: WebGL2RenderingContext }
  const compiled = proto._isRenderingStateCompiled
  if (typeof compiled !== 'function') return
  proto._isRenderingStateCompiled = function (this: typeof proto, ctx: GlPipeline): boolean {
    const done = compiled.call(this, ctx)
    const program = ctx?.program
    if (done && program && !settled.has(program)) {
      settled.add(program)
      const gl = ctx.context ?? this._gl
      // A program deleted since (its effect went while it linked) has nothing to settle.
      if (gl && gl.isProgram(program)) {
        try {
          settleProgram(gl, program)
        } catch {
          // a lost context: nothing to settle
        }
      }
    }
    return done
  }
}

// ---- inter-stage budget (WebGPU) ----------------------------------------------------------------------------------

/** What Chrome counts against maxInterStageShaderVariables for one processed WGSL fragment shader. */
export interface InterStageCount {
  /** User-defined inter-stage variables (`@location(n)` members of FragmentInputs). */
  user: number
  /** Built-ins that count too: front_facing (when read), sample_index, sample_mask. */
  builtins: number
  total: number
}

/** Counts the inter-stage variables of a processed WGSL fragment shader (Babylon's `struct FragmentInputs`). */
export function wgslInterStageCount(fragment: string): InterStageCount {
  const struct = /struct\s+FragmentInputs\s*\{([\s\S]*?)\}\s*;/.exec(fragment)
  const body = struct?.[1] ?? ''
  const user = (body.match(/@location\s*\(/g) ?? []).length
  const rest = struct ? fragment.slice(0, struct.index) + fragment.slice(struct.index + struct[0].length) : fragment
  let builtins = 0
  // Babylon always declares frontFacing; Tint counts it only when the entry point reads it.
  if (/\bfragmentInputs\s*\.\s*frontFacing\b/.test(rest) || /@builtin\s*\(\s*front_facing\s*\)/.test(rest)) builtins++
  // sample_index and an input sample_mask count as inputs (an output sample_mask lives in FragmentOutputs).
  if (/@builtin\s*\(\s*sample_index\s*\)/.test(body)) builtins++
  if (/@builtin\s*\(\s*sample_mask\s*\)/.test(body)) builtins++
  return { user, builtins, total: user + builtins }
}

let budgetInstalled = false
const budgetEngines = new WeakMap<AbstractEngine, { limit: number; warn: (msg: string) => void; seen: Set<string> }>()

/**
 * Dev: warns (once per shader) when a WGSL fragment shader of `engine` needs more inter-stage variables than the
 * device allows, before its pipeline is created. Returns the uninstall function. No-op on WebGL.
 */
export function installVaryingBudgetCheck(engine: AbstractEngine, warn: (msg: string) => void = m => console.warn(m)): () => void {
  if (!engine.isWebGPU) return () => {}
  const limits = (engine as unknown as { currentLimits?: { maxInterStageShaderVariables?: number } }).currentLimits
  const limit = limits?.maxInterStageShaderVariables ?? 16
  budgetEngines.set(engine, { limit, warn, seen: new Set() })
  if (!budgetInstalled) {
    budgetInstalled = true
    const proto = Effect.prototype as unknown as {
      _prepareEffect(keep?: boolean): void
      _fragmentSourceCode?: string
      getEngine(): AbstractEngine
      name: unknown
    }
    const prepare = proto._prepareEffect
    proto._prepareEffect = function (this: typeof proto, keep?: boolean) {
      const check = budgetEngines.get(this.getEngine())
      const src = this._fragmentSourceCode
      if (check && src) {
        const c = wgslInterStageCount(src)
        if (c.total > check.limit) {
          const name = typeof this.name === 'string' ? this.name : ((this.name as { fragment?: string; fragmentElement?: string } | null)?.fragment ?? 'shader')
          const key = `${name}|${c.user}|${c.builtins}`
          if (!check.seen.has(key)) {
            check.seen.add(key)
            check.warn(`[gpu] ${name}: ${c.total} inter-stage variables (${c.user} user + ${c.builtins} built-in) > maxInterStageShaderVariables ${check.limit}: WebGPU will drop the whole frame (RENDER §3.5)`)
          }
        }
      }
      return prepare.call(this, keep)
    }
  }
  return () => budgetEngines.delete(engine)
}

// ---- GL error probe (dev, WebGL) ------------------------------------------------------------------------------------

export interface GlErrorStats {
  draws: number
  /** Draws after which getError reported an error (each is a draw WebGL turned into a no-op). */
  failed: number
  byCode: Record<number, number>
  /** Failed draws per one-second window, newest last (up to 60). */
  perSecond: number[]
}

const DRAWS = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements'] as const

/**
 * Dev: counts the draws that raise a GL error (getError after each draw; it stalls, so never in production). Returns
 * live stats and the uninstall function. `log` gets a one-line summary for every second with failures.
 */
export function installGlErrorProbe(engine: AbstractEngine, log: (msg: string) => void = m => console.warn(m)): { stats: GlErrorStats; uninstall(): void } {
  const stats: GlErrorStats = { draws: 0, failed: 0, byCode: {}, perSecond: [] }
  const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl
  if (!gl || engine.isWebGPU) return { stats, uninstall: () => {} }
  const originals = new Map<string, unknown>()
  let window = 0
  const g = gl as unknown as Record<string, unknown>
  for (const name of DRAWS) {
    const fn = g[name]
    if (typeof fn !== 'function') continue
    originals.set(name, fn)
    g[name] = function (this: unknown, ...args: unknown[]) {
      const r = (fn as (...a: unknown[]) => unknown).apply(gl, args)
      stats.draws++
      const e = gl.getError()
      if (e !== gl.NO_ERROR) {
        stats.failed++
        window++
        stats.byCode[e] = (stats.byCode[e] ?? 0) + 1
      }
      return r
    }
  }
  const timer = setInterval(() => {
    stats.perSecond.push(window)
    if (stats.perSecond.length > 60) stats.perSecond.shift()
    if (window > 0) log(`[gpu] ${window} draws raised a GL error in the last second (${stats.failed} of ${stats.draws} since the probe started)`)
    window = 0
  }, 1000)
  return {
    stats,
    uninstall: () => {
      clearInterval(timer)
      for (const [name, fn] of originals) g[name] = fn
    },
  }
}

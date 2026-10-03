/**
 * Abuse hunt W9F, lens "uniformity" (docs/WAVE_PLAN3.md §8 item 3; docs/SKY.md "WGSL uniformity"): `textureSample`,
 * `textureSampleBias`, `textureSampleCompare`, `dpdx`/`dpdy` and `fwidth` must sit in uniform control flow, or Chrome's
 * Tint (and Safari's WGSL compiler) reject the whole WebGPU pipeline. The existing guards are textual (regexes over
 * the plugin snippets); this file checks the **assembled** WGSL instead:
 *
 * - a small Tint-like uniformity analysis (derivative_uniformity: private globals and fragment inputs are
 *   non-uniform, uniform buffers / handles / consts are uniform, values computed in non-uniform control flow are
 *   non-uniform, `if`/`switch`/loops reconverge only when every exit is "next", `return`/`break`/`continue` in
 *   non-uniform control flow taint what follows, calls are analysed per call site, `&&`/`||` short-circuit, locals
 *   are scoped), with a self-check on hand-written cases;
 * - a headless "WebGPU" NullEngine (Babylon's own WGSL processor and processing context on a NullEngine) that
 *   builds the real effects: every ShaderMaterial (terrain, water, grass, sky, rain x4, shelter) for every define set
 *   (none / all / each one / all but one), every PBR/Standard material family with the plugins (surface, wetness,
 *   foliage, water, fog, terrain) for every plugin define set, with and without the CSM (`SHADOWS` is what makes
 *   Babylon emit `diagnostic(off, derivative_uniformity)`), the Babylon contexts the presets turn on (cloth sheen,
 *   skin translucency, clustered lights with the sheen patch, alpha test, specular AA), the foliage ShadowDepthWrapper
 *   (which strips `SHADOWS` and so the diagnostic), and the post pipelines of render/post.ts.
 *
 * Result of the hunt: no violation in project code on any define set; the only non-uniform taps are Babylon's own CSM
 * PCF samples, always under Babylon's diagnostic. The last block documents what the textual guards cannot see.
 */
import {
  ClusteredLightContainer,
  Color3,
  Constants,
  DefaultRenderingPipeline,
  DirectionalLight,
  FSR1RenderingPipeline,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  RawTexture,
  SSAO2RenderingPipeline,
  SSRRenderingPipeline,
  Scene,
  ShaderLanguage,
  ShaderStore,
  ShadowGenerator,
  SphericalPolynomial,
  StandardMaterial,
  TAARenderingPipeline,
  Texture,
  Vector3,
  Vector4,
  VolumetricLightScatteringPostProcess,
  type Material,
  type Mesh,
} from '@babylonjs/core'
import { WebGPUShaderProcessingContext } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessingContext.js'
import { WebGPUShaderProcessorWGSL } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessorsWGSL.js'
import { describe, expect, it } from 'vitest'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import { FoliageShared, SroFoliagePlugin } from '../src/pbr/foliage-plugin.ts'
import { SroSurfacePlugin, SurfaceShared } from '../src/pbr/surface-plugin.ts'
import { TERRAIN_FEATURES, TerrainPbr, resolveTerrainFeatures, terrainPluginCode, type TerrainFeatures } from '../src/pbr/terrain-plugin.ts'
import { WaterPbrState, createPbrWater, waterFragmentCode } from '../src/pbr/water-plugin.ts'
import { installShaderFixes } from '../src/render/babylon-fixes.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { scatterShaders } from '../src/scatter-assets.ts'
import { terrainShaders, waterShaders } from '../src/shaders.ts'
import { skyFragmentWGSL, skyVertexWGSL } from '../src/sky/sky-shaders.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { WEATHER_PRESETS } from '../src/weather/presets.ts'
import { RAIN_SHADERS } from '../src/weather/rain.ts'
import { SHELTER_SHADERS } from '../src/weather/shelter.ts'
import { attachWetness } from '../src/weather/wet-plugin.ts'

// ---- a Tint-like WGSL uniformity analysis ------------------------------------------------------------------------

interface Violation { fn: string; op: string; line: number; chain: string[] }

interface Tok { t: string; line: number }

const OPS3 = ['<<=', '>>=']
const OPS2 = ['->', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '++', '--']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++
      out.push({ t: src.slice(i, j), line })
      i = j
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '-' || src[j + 1] === '+') && !/^0[xX]/.test(src.slice(i, j))) j += 2
        else j++
      }
      out.push({ t: src.slice(i, j), line })
      i = j
      continue
    }
    const three = src.slice(i, i + 3)
    if (OPS3.includes(three)) {
      out.push({ t: three, line })
      i += 3
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) {
      out.push({ t: two, line })
      i += 2
      continue
    }
    out.push({ t: c, line })
    i++
  }
  return out
}

type Expr =
  | { k: 'lit' }
  | { k: 'id'; name: string }
  | { k: 'call'; name: string; args: Expr[]; line: number }
  | { k: 'mem'; e: Expr }
  | { k: 'idx'; e: Expr; i: Expr }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }

type Stmt =
  | { k: 'block'; body: Stmt[] }
  | { k: 'decl'; name: string; init: Expr | null }
  | { k: 'assign'; lhs: Expr; rhs: Expr | null; op: string }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { k: 'loop'; init: Stmt | null; cond: Expr | null; update: Stmt | null; body: Stmt[]; continuing: Stmt[]; breakIf: Expr | null }
  | { k: 'switch'; sel: Expr; cases: { sels: Expr[]; body: Stmt[] }[] }
  | { k: 'return'; e: Expr | null }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'nop' }

interface Fn { name: string; params: { name: string; ptr: boolean }[]; body: Stmt[]; stage: string | null }
interface Module { fns: Map<string, Fn>; globals: Map<string, boolean>; diagnosticOff: boolean }

const TEMPLATED = new Set(['vec2', 'vec3', 'vec4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4', 'array', 'bitcast', 'ptr', 'atomic'])
const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
}
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='])

/** Parses Babylon's processed WGSL; every local is renamed per scope (`name#n`) so shadowing cannot hide a value. */
class Parser {
  private p = 0
  private scopes: Map<string, string>[] = []
  private uid = 0
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): string {
    return this.toks[this.p + o]?.t ?? '<eof>'
  }
  private next(): string {
    return this.toks[this.p++]?.t ?? '<eof>'
  }
  private eat(t: string): boolean {
    if (this.peek() !== t) return false
    this.p++
    return true
  }
  private expect(t: string): void {
    const g = this.next()
    if (g !== t) throw new Error(`line ${this.toks[this.p - 1]?.line}: expected ${t}, got ${g}`)
  }
  private declare(name: string): string {
    const u = `${name}#${++this.uid}`
    this.scopes[this.scopes.length - 1]!.set(name, u)
    return u
  }
  private resolve(name: string): string {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const u = this.scopes[i]!.get(name)
      if (u) return u
    }
    return name
  }
  private skipAttrs(): string[] {
    const a: string[] = []
    while (this.peek() === '@') {
      this.next()
      a.push(this.next())
      if (this.peek() === '(') this.skipBalanced('(', ')')
    }
    return a
  }
  private skipBalanced(open: string, close: string): void {
    this.expect(open)
    let d = 1
    while (d > 0) {
      const t = this.next()
      if (t === '<eof>') throw new Error('unexpected end')
      if (t === open) d++
      else if (t === close) d--
    }
  }
  private skipType(): void {
    this.next()
    if (this.peek() !== '<') return
    this.next()
    let d = 1
    while (d > 0) {
      const t = this.next()
      if (t === '<') d++
      else if (t === '>') d--
      else if (t === '>>') d -= 2
      else if (t === '<eof>') throw new Error('unexpected end in a type')
    }
  }
  private skipToSemicolon(): void {
    let d = 0
    for (;;) {
      const t = this.next()
      if (t === '<eof>') return
      if (t === '(' || t === '{' || t === '[') d++
      else if (t === ')' || t === '}' || t === ']') d--
      else if (t === ';' && d === 0) return
    }
  }

  module(): Module {
    const fns = new Map<string, Fn>()
    const globals = new Map<string, boolean>()
    let diagnosticOff = false
    while (this.peek() !== '<eof>') {
      const attrs = this.skipAttrs()
      const t = this.peek()
      if (t === ';') {
        this.next()
      } else if (t === 'diagnostic') {
        this.next()
        const s = this.p
        this.skipBalanced('(', ')')
        const txt = this.toks.slice(s, this.p).map(x => x.t).join('')
        if (txt.includes('off') && txt.includes('derivative_uniformity')) diagnosticOff = true
        this.eat(';')
      } else if (t === 'enable' || t === 'requires' || t === 'alias' || t === 'const_assert') {
        this.skipToSemicolon()
      } else if (t === 'struct') {
        this.next()
        this.next()
        this.skipBalanced('{', '}')
        this.eat(';')
      } else if (t === 'const' || t === 'override' || t === 'let') {
        this.next()
        globals.set(this.next(), false)
        this.skipToSemicolon()
      } else if (t === 'var') {
        this.next()
        let space = ''
        if (this.eat('<')) {
          while (this.peek() !== '>') space += this.next()
          this.next()
        }
        // handles (textures, samplers), uniform buffers and read-only storage are uniform; private, workgroup and
        // read_write storage are not (Tint: a read of a global with write access may be non-uniform)
        const uniform = space === '' || space === 'uniform' || space === 'storage' || space === 'storage,read'
        globals.set(this.next(), !uniform)
        this.skipToSemicolon()
      } else if (t === 'fn') {
        this.next()
        const name = this.next()
        const params: Fn['params'] = []
        this.scopes.push(new Map())
        this.expect('(')
        while (!this.eat(')')) {
          this.skipAttrs()
          const pn = this.declare(this.next())
          this.expect(':')
          const ptr = this.peek() === 'ptr'
          this.skipType()
          params.push({ name: pn, ptr })
          this.eat(',')
        }
        if (this.eat('->')) {
          this.skipAttrs()
          this.skipType()
        }
        const body = this.block()
        this.scopes.pop()
        const stage = attrs.find(a => a === 'fragment' || a === 'vertex' || a === 'compute') ?? null
        fns.set(name, { name, params, body, stage })
      } else {
        throw new Error(`unexpected top-level token ${t}`)
      }
    }
    return { fns, globals, diagnosticOff }
  }

  private block(): Stmt[] {
    this.expect('{')
    this.scopes.push(new Map())
    const out: Stmt[] = []
    while (!this.eat('}')) out.push(this.stmt())
    this.scopes.pop()
    return out
  }

  private stmt(): Stmt {
    this.skipAttrs()
    const t = this.peek()
    if (t === ';') {
      this.next()
      return { k: 'nop' }
    }
    if (t === '{') return { k: 'block', body: this.block() }
    if (t === 'var' || t === 'let' || t === 'const') {
      const s = this.decl()
      this.expect(';')
      return s
    }
    if (t === 'if') return this.ifStmt()
    if (t === 'for') {
      this.next()
      this.scopes.push(new Map())
      this.expect('(')
      const init = this.peek() === ';' ? null : this.simple()
      this.expect(';')
      const cond = this.peek() === ';' ? null : this.expr()
      this.expect(';')
      const update = this.peek() === ')' ? null : this.simple()
      this.expect(')')
      const body = this.block()
      this.scopes.pop()
      return { k: 'loop', init, cond, update, body, continuing: [], breakIf: null }
    }
    if (t === 'while') {
      this.next()
      const cond = this.expr()
      return { k: 'loop', init: null, cond, update: null, body: this.block(), continuing: [], breakIf: null }
    }
    if (t === 'loop') {
      this.next()
      this.expect('{')
      this.scopes.push(new Map())
      const body: Stmt[] = []
      const continuing: Stmt[] = []
      let breakIf: Expr | null = null
      while (!this.eat('}')) {
        if (this.peek() !== 'continuing') {
          body.push(this.stmt())
          continue
        }
        this.next()
        this.expect('{')
        this.scopes.push(new Map())
        while (!this.eat('}')) {
          if (this.peek() === 'break' && this.peek(1) === 'if') {
            this.next()
            this.next()
            breakIf = this.expr()
            this.expect(';')
          } else continuing.push(this.stmt())
        }
        this.scopes.pop()
      }
      this.scopes.pop()
      return { k: 'loop', init: null, cond: null, update: null, body, continuing, breakIf }
    }
    if (t === 'switch') {
      this.next()
      const sel = this.expr()
      this.skipAttrs()
      this.expect('{')
      const cases: { sels: Expr[]; body: Stmt[] }[] = []
      while (!this.eat('}')) {
        const sels: Expr[] = []
        if (!this.eat('default')) {
          this.expect('case')
          for (;;) {
            if (!this.eat('default')) sels.push(this.expr())
            if (!this.eat(',') || this.peek() === ':' || this.peek() === '{') break
          }
        }
        this.eat(':')
        cases.push({ sels, body: this.block() })
      }
      return { k: 'switch', sel, cases }
    }
    if (t === 'return') {
      this.next()
      const e = this.peek() === ';' ? null : this.expr()
      this.expect(';')
      return { k: 'return', e }
    }
    if (t === 'break') {
      this.next()
      if (this.eat('if')) {
        const cond = this.expr()
        this.expect(';')
        return { k: 'if', cond, then: [{ k: 'break' }], els: null }
      }
      this.expect(';')
      return { k: 'break' }
    }
    if (t === 'continue' || t === 'discard') {
      // discard demotes to a helper invocation: no effect on uniformity (WGSL since 2023)
      this.next()
      this.expect(';')
      return t === 'continue' ? { k: 'continue' } : { k: 'nop' }
    }
    const s = this.simple()
    this.expect(';')
    return s
  }

  private ifStmt(): Stmt {
    this.expect('if')
    const cond = this.expr()
    const then = this.block()
    let els: Stmt[] | null = null
    if (this.eat('else')) els = this.peek() === 'if' ? [this.ifStmt()] : this.block()
    return { k: 'if', cond, then, els }
  }

  private decl(): Stmt {
    const kw = this.next()
    if (kw === 'var' && this.eat('<')) {
      while (this.next() !== '>') {
        // the address space
      }
    }
    const raw = this.next()
    if (this.eat(':')) this.skipType()
    const init = this.eat('=') ? this.expr() : null
    return { k: 'decl', name: this.declare(raw), init }
  }

  private simple(): Stmt {
    const t = this.peek()
    if (t === 'var' || t === 'let' || t === 'const') return this.decl()
    if (t === '_' && this.peek(1) === '=') {
      this.next()
      this.next()
      return { k: 'expr', e: this.expr() }
    }
    const lhs = this.expr()
    const op = this.peek()
    if (ASSIGN.has(op)) {
      this.next()
      return { k: 'assign', lhs, rhs: this.expr(), op }
    }
    if (op === '++' || op === '--') {
      this.next()
      return { k: 'assign', lhs, rhs: null, op }
    }
    return { k: 'expr', e: lhs }
  }

  private expr(minPrec = 1): Expr {
    let a = this.unary()
    for (;;) {
      const op = this.peek()
      const pr = PREC[op]
      if (pr === undefined || pr < minPrec) return a
      this.next()
      a = { k: 'bin', op, a, b: this.expr(pr + 1) }
    }
  }
  private unary(): Expr {
    const t = this.peek()
    if (t === '-' || t === '!' || t === '~' || t === '&' || t === '*') {
      this.next()
      return { k: 'un', op: t, e: this.unary() }
    }
    return this.postfix(this.primary())
  }
  private primary(): Expr {
    const line = this.toks[this.p]?.line ?? -1
    const t = this.next()
    if (t === '(') {
      const e = this.expr()
      this.expect(')')
      return e
    }
    if (/^[0-9.]/.test(t) || t === 'true' || t === 'false') return { k: 'lit' }
    if (!/^[A-Za-z_]/.test(t)) throw new Error(`line ${line}: unexpected token ${t}`)
    if (TEMPLATED.has(t) && this.peek() === '<') {
      this.p--
      this.skipType()
    }
    if (this.eat('(')) {
      const args: Expr[] = []
      while (!this.eat(')')) {
        args.push(this.expr())
        this.eat(',')
      }
      return { k: 'call', name: t, args, line }
    }
    return { k: 'id', name: this.resolve(t) }
  }
  private postfix(e: Expr): Expr {
    for (;;) {
      if (this.eat('.')) {
        this.next()
        e = { k: 'mem', e }
      } else if (this.eat('[')) {
        const i = this.expr()
        this.expect(']')
        e = { k: 'idx', e, i }
      } else return e
    }
  }
}

/** The builtins that need uniform control flow (implicit derivatives). */
const DERIV = new Set(['textureSample', 'textureSampleBias', 'textureSampleCompare', 'dpdx', 'dpdxCoarse', 'dpdxFine', 'dpdy', 'dpdyCoarse', 'dpdyFine', 'fwidth', 'fwidthCoarse', 'fwidthFine'])

type Env = Map<string, boolean>
interface Beh { next: boolean; ret: boolean; brk: boolean; cont: boolean }
interface Ctx { f: Fn; chain: string[]; retNU: boolean; ptrWrites: Map<string, boolean> }
interface Flow { cf: boolean; beh: Beh }
const NEXT: Beh = { next: true, ret: false, brk: false, cont: false }
const onlyNext = (b: Beh) => b.next && !b.ret && !b.brk && !b.cont

class Analyzer {
  readonly violations: Violation[] = []
  readonly unknown = new Set<string>()
  private readonly memo = new Map<string, { retNU: boolean; ptrNU: boolean[] }>()
  private readonly seen = new Set<string>()
  constructor(private readonly mod: Module) {}

  run(): Violation[] {
    for (const f of this.mod.fns.values()) {
      if (f.stage === 'fragment') this.call(f, f.params.map(() => true), false, [f.name])
      // no implicit derivative at all in a vertex shader: analysed as if in non-uniform control flow
      else if (f.stage === 'vertex') this.call(f, f.params.map(() => true), true, [`@vertex ${f.name}`])
    }
    return this.violations
  }

  private call(f: Fn, argNU: boolean[], cf: boolean, chain: string[]): { retNU: boolean; ptrNU: boolean[] } {
    const key = `${f.name}|${argNU.map(Number).join('')}|${Number(cf)}`
    const hit = this.memo.get(key)
    if (hit) return hit
    const env: Env = new Map()
    f.params.forEach((p, i) => env.set(p.name, !!argNU[i]))
    const ctx: Ctx = { f, chain, retNU: false, ptrWrites: new Map() }
    this.stmts(f.body, env, cf, ctx)
    const res = { retNU: ctx.retNU, ptrNU: f.params.map(p => p.ptr && !!ctx.ptrWrites.get(p.name)) }
    this.memo.set(key, res)
    return res
  }

  private read(name: string, env: Env): boolean {
    if (env.has(name)) return env.get(name)!
    const g = this.mod.globals.get(name)
    if (g === undefined) this.unknown.add(name)
    return g ?? false
  }

  private root(e: Expr): string | null {
    if (e.k === 'id') return e.name
    if (e.k === 'mem' || e.k === 'idx' || (e.k === 'un' && (e.op === '*' || e.op === '&'))) return this.root(e.e)
    return null
  }

  private write(name: string, nu: boolean, env: Env, ctx: Ctx): void {
    if (!env.has(name)) return
    env.set(name, nu)
    if (ctx.f.params.some(p => p.ptr && p.name === name)) ctx.ptrWrites.set(name, (ctx.ptrWrites.get(name) ?? false) || nu)
  }

  private expr(e: Expr, env: Env, cf: boolean, ctx: Ctx): boolean {
    switch (e.k) {
      case 'lit':
        return false
      case 'id':
        return this.read(e.name, env)
      case 'mem':
      case 'un':
        return this.expr(e.e, env, cf, ctx)
      case 'idx': {
        const a = this.expr(e.e, env, cf, ctx)
        const b = this.expr(e.i, env, cf, ctx)
        return a || b
      }
      case 'bin': {
        const a = this.expr(e.a, env, cf, ctx)
        // the right side of && / || only runs when the left says so: its control flow depends on the left
        const b = this.expr(e.b, env, e.op === '&&' || e.op === '||' ? cf || a : cf, ctx)
        return a || b
      }
      case 'call': {
        const argNU = e.args.map(a => this.expr(a, env, cf, ctx))
        if (DERIV.has(e.name) && cf) {
          const k = `${ctx.f.name}:${e.line}:${e.name}`
          if (!this.seen.has(k)) {
            this.seen.add(k)
            this.violations.push({ fn: ctx.f.name, op: e.name, line: e.line, chain: ctx.chain })
          }
        }
        const f = this.mod.fns.get(e.name)
        if (!f) return argNU.some(Boolean)
        const r = this.call(f, argNU, cf, [...ctx.chain, `${f.name}@${e.line}`])
        f.params.forEach((p, i) => {
          const n = p.ptr && r.ptrNU[i] ? this.root(e.args[i]!) : null
          if (n) this.write(n, true, env, ctx)
        })
        return r.retNU || cf
      }
    }
  }

  private stmts(list: Stmt[], env: Env, cf: boolean, ctx: Ctx): Flow {
    let cur = cf
    const beh: Beh = { ...NEXT }
    for (const s of list) {
      if (!beh.next) break
      const r = this.stmt(s, env, cur, ctx)
      beh.ret ||= r.beh.ret
      beh.brk ||= r.beh.brk
      beh.cont ||= r.beh.cont
      beh.next = r.beh.next
      cur = r.cf
    }
    return { cf: cur, beh }
  }

  private lhsIndexNU(e: Expr, env: Env, cf: boolean, ctx: Ctx): boolean {
    if (e.k === 'idx') {
      const a = this.expr(e.i, env, cf, ctx)
      const b = this.lhsIndexNU(e.e, env, cf, ctx)
      return a || b
    }
    return e.k === 'mem' ? this.lhsIndexNU(e.e, env, cf, ctx) : false
  }

  private stmt(s: Stmt, env: Env, cf: boolean, ctx: Ctx): Flow {
    switch (s.k) {
      case 'nop':
        return { cf, beh: { ...NEXT } }
      case 'block':
        return this.stmts(s.body, env, cf, ctx)
      case 'decl':
        env.set(s.name, s.init ? this.expr(s.init, env, cf, ctx) || cf : false)
        return { cf, beh: { ...NEXT } }
      case 'assign': {
        const v = (s.rhs ? this.expr(s.rhs, env, cf, ctx) : false) || cf
        const idx = this.lhsIndexNU(s.lhs, env, cf, ctx)
        const n = this.root(s.lhs)
        if (n) {
          const partial = s.lhs.k !== 'id' || s.op !== '='
          this.write(n, (partial && this.read(n, env)) || v || idx, env, ctx)
        }
        return { cf, beh: { ...NEXT } }
      }
      case 'expr':
        this.expr(s.e, env, cf, ctx)
        return { cf, beh: { ...NEXT } }
      case 'return': {
        // evaluate first: `||=` would skip a tap in the returned expression
        const v = s.e ? this.expr(s.e, env, cf, ctx) : false
        ctx.retNU = ctx.retNU || v || cf
        return { cf, beh: { next: false, ret: true, brk: false, cont: false } }
      }
      case 'break':
        return { cf, beh: { next: false, ret: false, brk: true, cont: false } }
      case 'continue':
        return { cf, beh: { next: false, ret: false, brk: false, cont: true } }
      case 'if': {
        const c = this.expr(s.cond, env, cf, ctx) || cf
        const e1 = new Map(env)
        const r1 = this.stmts(s.then, e1, c, ctx)
        const e2 = new Map(env)
        const r2 = s.els ? this.stmts(s.els, e2, c, ctx) : { cf: c, beh: { ...NEXT } }
        for (const k of env.keys()) env.set(k, (e1.get(k) ?? false) || (e2.get(k) ?? false))
        const beh: Beh = {
          next: r1.beh.next || r2.beh.next,
          ret: r1.beh.ret || r2.beh.ret,
          brk: r1.beh.brk || r2.beh.brk,
          cont: r1.beh.cont || r2.beh.cont,
        }
        // reconverges only when both sides only fall through (Tint: the if's behaviour is {Next})
        const out = onlyNext(beh) ? cf : cf || c || (r1.beh.next && r1.cf) || (r2.beh.next && r2.cf)
        return { cf: out, beh }
      }
      case 'switch': {
        const c = this.expr(s.sel, env, cf, ctx) || cf
        for (const cs of s.cases) for (const x of cs.sels) this.expr(x, env, cf, ctx)
        const beh: Beh = { next: false, ret: false, brk: false, cont: false }
        const merged = new Map(env)
        let endNU = false
        for (const cs of s.cases) {
          const e1 = new Map(env)
          const r = this.stmts(cs.body, e1, c, ctx)
          for (const k of env.keys()) merged.set(k, (merged.get(k) ?? false) || (e1.get(k) ?? false))
          beh.next ||= r.beh.next || r.beh.brk
          beh.ret ||= r.beh.ret
          beh.cont ||= r.beh.cont
          if (r.beh.next) endNU ||= r.cf
        }
        for (const [k, v] of merged) env.set(k, v)
        return { cf: onlyNext(beh) ? cf : cf || c || endNU, beh }
      }
      case 'loop': {
        if (s.init) this.stmt(s.init, env, cf, ctx)
        let header = cf
        let ret = false
        for (let iter = 0; iter < 10; iter++) {
          const before = JSON.stringify([...env]) + header
          // for / while: `if (!cond) { break; }` first
          const bodyCf = s.cond ? this.expr(s.cond, env, header, ctx) || header : header
          const r = this.stmts(s.body, env, bodyCf, ctx)
          const rc = this.stmts(s.continuing, env, r.cf || (r.beh.cont && bodyCf), ctx)
          let end = rc.cf
          if (s.update) this.stmt(s.update, env, end, ctx)
          if (s.breakIf) end = this.expr(s.breakIf, env, end, ctx) || end
          // a break / continue / return in non-uniform control flow makes the next iteration non-uniform
          header = header || end || r.cf
          ret = r.beh.ret || rc.beh.ret
          if (JSON.stringify([...env]) + header === before) break
        }
        const beh: Beh = { next: true, ret, brk: false, cont: false }
        return { cf: onlyNext(beh) ? cf : cf || header, beh }
      }
    }
  }
}

interface Analysis { diagnosticOff: boolean; violations: Violation[]; unknown: string[]; entries: number }

function analyze(src: string): Analysis {
  const mod = new Parser(tokenize(src)).module()
  const a = new Analyzer(mod)
  const violations = a.run()
  const entries = [...mod.fns.values()].filter(f => f.stage === 'fragment' || f.stage === 'vertex').length
  return { diagnosticOff: mod.diagnosticOff, violations, unknown: [...a.unknown], entries }
}

const describeV = (v: Violation) => `${v.op} (line ${v.line}) in ${v.chain.join(' > ')}`

// ---- a headless "WebGPU" engine: Babylon's WGSL processor on a NullEngine ------------------------------------------

function wgslEngine(): NullEngine {
  const engine = new NullEngine()
  const e = engine as unknown as Record<string, unknown>
  e._isWebGPU = true
  e._webGLVersion = 2
  Object.defineProperty(engine, 'supportsUniformBuffers', { get: () => true })
  Object.defineProperty(engine, 'shaderPlatformName', { get: () => 'WEBGPU' })
  Object.defineProperty(engine, 'isNDCHalfZRange', { get: () => true })
  const caps = engine.getCaps()
  caps.textureLOD = true
  caps.texelFetch = true
  caps.textureFloat = true
  caps.textureFloatRender = true
  caps.textureHalfFloat = true
  caps.textureHalfFloatRender = true
  caps.textureHalfFloatLinearFiltering = true
  // ClusteredLightContainer on WebGPU uses storage buffers
  e._storageBuffers = []
  e.createStorageBuffer = () => ({ capacity: 0, references: 1, underlyingResource: null })
  e.clearStorageBuffer = () => {}
  e.updateStorageBuffer = () => {}
  e.setStorageBuffer = () => {}
  e.readFromStorageBuffer = async () => new Uint8Array(0)
  const wgsl = new WebGPUShaderProcessorWGSL()
  const orig = engine._getShaderProcessor.bind(engine)
  e._getShaderProcessor = (lang: ShaderLanguage) => (lang === ShaderLanguage.WGSL ? wgsl : orig(lang))
  e._getShaderProcessingContext = (lang: ShaderLanguage, pure: boolean) => new WebGPUShaderProcessingContext(lang, pure)
  return engine
}

interface Built { code: string; defines: string }
interface Effectish { _fragmentSourceCode: string; _vertexSourceCode: string; defines: string }

async function buildShaderMaterial(engine: NullEngine, name: string, defines: string[]): Promise<{ frag: string; vert: string }> {
  const eff = engine.createEffect({ vertex: name, fragment: name }, {
    attributes: [], uniformsNames: [], uniformBuffersNames: [], samplers: [], defines: defines.map(d => `#define ${d}`).join('\n'),
    fallbacks: null, onCompiled: null, onError: null, indexParameters: {}, shaderLanguage: ShaderLanguage.WGSL,
  }, engine) as unknown as Effectish
  for (let i = 0; i < 400 && !eff._fragmentSourceCode; i++) await new Promise(r => setTimeout(r, 2))
  return { frag: eff._fragmentSourceCode, vert: eff._vertexSourceCode }
}

/** Plugin defines forced on top of what each plugin prepares (every define set a preset or weather level can make). */
let force: Record<string, boolean> = {}
function forcePlugins(mat: Material): void {
  const pm = mat.pluginManager as unknown as { _plugins: Array<{ prepareDefines: (...a: unknown[]) => void; abuseForced?: boolean }> } | null
  for (const p of pm?._plugins ?? []) {
    if (p.abuseForced) continue
    p.abuseForced = true
    const orig = p.prepareDefines.bind(p)
    p.prepareDefines = (d: unknown, ...rest: unknown[]) => {
      orig(d, ...rest)
      const dd = d as Record<string, unknown>
      for (const [k, v] of Object.entries(force)) if (k in dd) dd[k] = v
    }
  }
}

interface Rig { engine: NullEngine; scene: Scene; tex: RawTexture; sun: DirectionalLight }

/** A PBR-preset-shaped scene: sun (light 0) with an optional CSM stand-in, a hemispheric fill, an environment cube. */
function rig(shadows: boolean): Rig {
  const engine = wgslEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const sun = new DirectionalLight('celestial', new Vector3(-1, -1, 0), scene)
  new HemisphericLight('fill', new Vector3(0, 1, 0), scene)
  if (shadows) {
    const csm = {
      id: 'csm',
      getShadowMap: () => ({ renderList: scene.meshes }),
      isReady: () => true,
      prepareDefines: (d: Record<string, unknown>, i: number) => {
        d[`SHADOW${i}`] = true
        d[`SHADOWCSM${i}`] = true
        d[`SHADOWCSMNUM_CASCADES${i}`] = 3
        d[`SHADOWCSMUSESHADOWMAXZ${i}`] = true
        d[`SHADOWPCF${i}`] = true
      },
      bindShadowLight: () => {},
      getClassName: () => 'CascadedShadowGenerator',
      dispose: () => {},
    }
    ;(sun as unknown as { _shadowGenerators: Map<unknown, unknown> })._shadowGenerators = new Map([[null, csm]])
  }
  const env = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
  env.getInternalTexture()!.isCube = true
  env.sphericalPolynomial = new SphericalPolynomial()
  env.isReady = () => true
  scene.environmentTexture = env
  scene.createDefaultCamera()
  const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
  tex.getInternalTexture()!.isReady = true
  tex.isReady = () => true
  return { engine, scene, tex, sun }
}

/** Compiles the mesh's material with the forced plugin defines; the processed WGSL of its effect. */
async function compileMesh(mesh: Mesh): Promise<Built | null> {
  const mat = mesh.material!
  forcePlugins(mat)
  mat.markDirty(true)
  for (let i = 0; i < 400; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) break
    await new Promise(r => setTimeout(r, 3))
  }
  const e = mesh.subMeshes[0]!.effect as unknown as Effectish | null
  return e?._fragmentSourceCode ? { code: e._fragmentSourceCode, defines: e.defines } : null
}

const SURF = ['SRO_SURFACE', 'SRO_LUMA_ROUGH', 'SRO_BAKED', 'SRO_WET', 'SRO_PUDDLES', 'SRO_SHELTER', 'SRO_CLOUDSHADOW', 'SRO_LAMP', 'SRO_SELFLIT', 'WX_OCC8']
const WET = ['WX', 'WX_SHELTER', 'WX_REFL', 'WX_FOLIAGE', 'WX_OCC8']
const FOL = ['SRO_FOLIAGE', 'SRO_FOL_WIND', 'SRO_FOL_FLUTTER', 'SRO_FOL_TRANSL']
const WAT = ['SRO_WATER', 'SRO_WATER_SHORE', 'SRO_WATER_RIPPLE']
const FOG = ['SRO_HEIGHTFOG', 'SRO_FOG_RING']

/** base, all, and each define alone (on top of `base`). */
function defineSets(names: readonly string[], base: readonly string[] = []): Array<[string, Record<string, boolean>]> {
  const on = (xs: readonly string[]) => Object.fromEntries([...base, ...xs].map(n => [n, true]))
  return [['base', on([])], ['all', on(names)], ...names.map(n => [`only ${n}`, on([n])] as [string, Record<string, boolean>])]
}

interface Family {
  name: string
  make: (r: Rig) => Mesh
  sets: Array<[string, Record<string, boolean>]>
}

const FAMILIES: Family[] = [
  {
    // world objects on PBR: class roughness, object lightmap (SRO_BAKED), wetness, puddles, lamps, fog
    name: 'object',
    make: r => {
      const mat = new PBRMaterial('obj', r.scene)
      mat.albedoTexture = r.tex
      mat.lightmapTexture = r.tex
      mat.useLightmapAsShadowmap = true
      mat.bumpTexture = r.tex
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'stone', baked: true })
      attachFogPlugin(mat, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('obj', {}, r.scene)
      mesh.material = mat
      return mesh
    },
    sets: defineSets([...SURF, ...FOG], ['SRO_SURFACE']),
  },
  {
    // a character on the Classic path: WX-C's actor wetness only
    name: 'actor classic',
    make: r => {
      const mat = new PBRMaterial('chinaman_body', r.scene)
      mat.albedoTexture = r.tex
      attachWetness(mat, 'actor')
      const mesh = MeshBuilder.CreateBox('actor', {}, r.scene)
      mesh.material = mat
      return mesh
    },
    sets: defineSets(WET),
  },
  {
    // the same character after the live switch: wetness + surface + fog on one material
    name: 'actor pbr',
    make: r => {
      const mat = new PBRMaterial('chinaman_body', r.scene)
      mat.albedoTexture = r.tex
      attachWetness(mat, 'actor')
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'cloth' })
      attachFogPlugin(mat, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('actor', {}, r.scene)
      mesh.material = mat
      return mesh
    },
    sets: defineSets([...SURF.filter(n => n !== 'SRO_BAKED' && n !== 'SRO_SHELTER'), ...WET.filter(n => n !== 'WX_SHELTER'), ...FOG], ['SRO_SURFACE']),
  },
  {
    name: 'foliage leaf',
    make: r => {
      const mat = new PBRMaterial('tre_leaf', r.scene)
      mat.albedoTexture = r.tex
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage' })
      new SroFoliagePlugin(mat, new FoliageShared(), { leaf: true, kind: 'static' })
      attachFogPlugin(mat, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('leaf', {}, r.scene)
      mesh.material = mat
      return mesh
    },
    sets: defineSets([...FOL, ...SURF.filter(n => n !== 'SRO_BAKED'), ...FOG], ['SRO_SURFACE']),
  },
  {
    // BT-P (wave 10): a region batch's table group (SRO_TABLE: table fetches, atlas and lightmap arrays with explicit
    // gradients, the six derivatives at the top of main), as a cut-out lamp group (rescaled alpha test, texel-5 glow)
    name: 'batch table group',
    make: r => {
      const mat = new PBRMaterial('batch:cutout+lamp', r.scene)
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'stone', selfLit: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      attachFogPlugin(mat, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('batch', {}, r.scene)
      mesh.setVerticesData('uv2', new Float32Array(mesh.getTotalVertices() * 2), false, 2)
      mesh.material = mat
      return mesh
    },
    sets: defineSets([...SURF, ...FOG], ['SRO_SURFACE', 'SRO_TABLE']),
  },
  {
    // BT-P (wave 10): a region batch's merged trees: the table group + the foliage pivot and the minimum breeze
    name: 'batch tree group',
    make: r => {
      const mat = new PBRMaterial('batch:leaf', r.scene)
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage', table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      new SroFoliagePlugin(mat, new FoliageShared(), { leaf: true, kind: 'static', breeze: 0.15, shadowWrapper: false })
      attachFogPlugin(mat, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('trees', {}, r.scene)
      const n = mesh.getTotalVertices()
      mesh.setVerticesData('uv2', new Float32Array(n * 2), false, 2)
      mesh.setVerticesData('sroPivot', new Float32Array(n * 3), false, 3)
      mesh.material = mat
      return mesh
    },
    sets: defineSets([...FOL, 'SRO_FOL_PIVOT', 'SRO_FOL_BREEZE', ...SURF, ...FOG], ['SRO_SURFACE', 'SRO_TABLE']),
  },
  {
    // PBR water: every normal / frame / ripple tap is a textureSample at CUSTOM_FRAGMENT_MAIN_BEGIN
    name: 'water pbr',
    make: r => {
      const st = new WaterPbrState()
      st.frames = r.tex
      st.normal = r.tex
      const { material } = createPbrWater(r.scene, st)
      attachFogPlugin(material, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('water', {}, r.scene)
      mesh.setVerticesData('color', new Float32Array(mesh.getTotalVertices() * 4).fill(0.5), false, 4)
      mesh.material = material
      return mesh
    },
    sets: defineSets([...WAT, ...FOG], ['SRO_WATER']),
  },
  {
    // Classic objects and static foliage: StandardMaterial + wetness (diffuse, lightmap, sway)
    name: 'standard',
    make: r => {
      const mat = new StandardMaterial('std', r.scene)
      mat.diffuseTexture = r.tex
      mat.lightmapTexture = r.tex
      mat.useLightmapAsShadowmap = true
      attachWetness(mat, 'static', { foliage: true })
      const mesh = MeshBuilder.CreateBox('std', {}, r.scene)
      mesh.material = mat
      return mesh
    },
    sets: defineSets(WET),
  },
]

/** Every terrain define set the presets make (4 quality x 5 weather levels), and each feature alone. */
function terrainFeatureSets(): Array<[string, TerrainFeatures]> {
  const out: Array<[string, TerrainFeatures]> = []
  for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
    for (const w of Object.keys(WEATHER_PRESETS) as Array<keyof typeof WEATHER_PRESETS>) {
      const nightSplat = q === 'low' || q === 'medium'
      out.push([`${q}/${w}`, resolveTerrainFeatures({
        quality: RENDER_PRESETS[q], sky: SKY_PRESETS[q], weather: WEATHER_PRESETS[w], arrays: { normal: true, ormh: true },
        externs: { shelter: true, cloudShadow: true, nightSplat },
      } as Parameters<typeof resolveTerrainFeatures>[0])])
    }
  }
  const none = Object.fromEntries(TERRAIN_FEATURES.map(k => [k, false])) as unknown as TerrainFeatures
  const all = Object.fromEntries(TERRAIN_FEATURES.map(k => [k, true])) as unknown as TerrainFeatures
  out.push(['all but the night splat', { ...all, nightSplat: false }], ['all but the tier plane', { ...all, tier: false }])
  for (const k of TERRAIN_FEATURES) if (k !== 'parallax') out.push([`only ${k}`, { ...none, [k]: true }])
  out.push(['parallax + ormh', { ...none, parallax: true, ormh: true }])
  return out
}

function terrainRig(shadows: boolean): { r: Rig; pbr: TerrainPbr; mesh: Mesh } {
  const r = rig(shadows)
  const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]))
  pbr.tiles = pbr.normals = pbr.ormh = r.tex
  const { material } = pbr.createMaterial('t', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
  const mesh = MeshBuilder.CreateGround('terrain', { width: 2, height: 2 }, r.scene)
  mesh.receiveShadows = shadows
  mesh.material = material
  return { r, pbr, mesh }
}

/** Violations outside Babylon's CSM PCF helpers (the only non-uniform taps allowed, under Babylon's diagnostic). */
const projectViolations = (a: Analysis) => a.violations.filter(v => !/^computeShadowWithCSM/.test(v.fn))

function expectClean(label: string, a: Analysis): void {
  expect(a.entries, `${label}: an entry point was analysed`).toBe(1)
  expect(a.unknown, `${label}: every identifier resolves`).toEqual([])
  if (a.diagnosticOff) expect(projectViolations(a).map(describeV), `${label} (under Babylon's diagnostic(off))`).toEqual([])
  else expect(a.violations.map(describeV), label).toEqual([])
}

// ---- the analysis itself ---------------------------------------------------------------------------------------

const HEAD = '@group(0) @binding(0) var t: texture_2d<f32>;\n@group(0) @binding(1) var s: sampler;\n'
const frag = (body: string, extra = '') => `${HEAD}${extra}@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {\n${body}\n}\n`
const ops = (src: string) => analyze(src).violations.map(v => v.op)

describe('the uniformity analysis (self-check against the WGSL rules)', () => {
  it('flags implicit-derivative taps in per-pixel branches, after a non-uniform return, in helpers and loops', () => {
    expect(ops(frag('var c = vec4f(0.0);\nif (uv.x > 0.5) { c = textureSample(t, s, uv); }\nreturn c;'))).toEqual(['textureSample'])
    expect(ops(frag('if (uv.x > 0.5) { return vec4f(1.0); }\nreturn textureSampleBias(t, s, uv, 0.0);'))).toEqual(['textureSampleBias'])
    expect(ops(frag('var c = 0.0;\nif (uv.x > 0.5) { c = dpdx(uv.x); }\nreturn vec4f(c);'))).toEqual(['dpdx'])
    expect(ops(frag('var c = vec4f(0.0);\nif (uv.x > 0.5) { c = h(uv); }\nreturn c;', 'fn h(p: vec2f) -> vec4f { return textureSample(t, s, p); }\n'))).toEqual(['textureSample'])
    expect(ops(frag('var c = vec4f(0.0);\nfor (var i = 0; i < 4; i++) { if (uv.x > f32(i)) { continue; } c = c + textureSample(t, s, uv); }\nreturn c;'))).toEqual(['textureSample'])
    expect(ops(frag('let a = uv.x > 0.5 && fwidth(uv.y) > 0.1;\nreturn vec4f(select(0.0, 1.0, a));'))).toEqual(['fwidth'])
    // a shadowing inner `let` does not launder the outer non-uniform value
    expect(ops(frag('let c = uv.x;\n{ let c = 1.0; }\nvar o = vec4f(0.0);\nif (c > 0.5) { o = textureSample(t, s, uv); }\nreturn o;'))).toEqual(['textureSample'])
    // private globals (Babylon's fragmentInputs) are non-uniform
    expect(ops(frag('fi = uv;\nvar o = vec4f(0.0);\nif (fi.x > 0.5) { o = textureSample(t, s, uv); }\nreturn o;', 'var<private> fi: vec2f;\n'))).toEqual(['textureSample'])
  })

  it('accepts what WGSL accepts: uniform branches, taps after a loop with a per-pixel break, explicit-LOD taps anywhere', () => {
    const u = 'struct U { k: vec4f };\n@group(0) @binding(2) var<uniform> uniforms: U;\n'
    expect(ops(frag('var c = vec4f(0.0);\nif (uniforms.k.x > 0.5) { c = textureSample(t, s, uv); }\nreturn c;', u))).toEqual([])
    expect(ops(frag('for (var i = 0; i < 4; i++) { if (uv.x > f32(i)) { break; } }\nreturn textureSample(t, s, uv);'))).toEqual([])
    expect(ops(frag('var c = vec4f(0.0);\nif (uv.x > 0.5) { c = textureSampleLevel(t, s, uv, 0.0) + textureSampleGrad(t, s, uv, vec2f(0.0), vec2f(0.0)); }\nreturn c;'))).toEqual([])
    expect(ops(frag('if (uv.x > 0.5) { discard; }\nreturn textureSample(t, s, uv);'))).toEqual([])
    expect(analyze(`diagnostic(off, derivative_uniformity);\n${frag('return textureSample(t, s, uv);')}`).diagnosticOff).toBe(true)
  })

  it('an implicit-derivative tap in a vertex shader is always an error', () => {
    expect(ops(`${HEAD}@vertex fn main() -> @builtin(position) vec4f { return textureSample(t, s, vec2f(0.0)); }\n`)).toEqual(['textureSample'])
  })
})

// ---- ShaderMaterials: every define set -------------------------------------------------------------------------

const definesOf = (src: string) => [...new Set([...src.matchAll(/#(?:ifdef|ifndef)\s+(\w+)/g), ...src.matchAll(/defined\((\w+)\)/g)].map(m => m[1]!))].sort()

describe('assembled WGSL: the ShaderMaterials, every define set (none, all, each one, all but one)', () => {
  const sources: Record<string, { vertexWGSL: string; fragmentWGSL: string; extra?: string[] }> = {
    terrain: terrainShaders(),
    water: waterShaders(),
    grass: scatterShaders(),
    sky: { vertexWGSL: skyVertexWGSL, fragmentWGSL: skyFragmentWGSL, extra: ['SKY_LIGHT_TAPS 3'] },
    ...RAIN_SHADERS,
    shelter: SHELTER_SHADERS,
  }
  it.each(Object.keys(sources))('%s: no implicit derivative in non-uniform control flow, none in the vertex stage', async name => {
    const s = sources[name]!
    const engine = wgslEngine()
    try {
      const id = `abuseW9f_${name}`
      ShaderStore.ShadersStoreWGSL[`${id}VertexShader`] = s.vertexWGSL
      ShaderStore.ShadersStoreWGSL[`${id}FragmentShader`] = s.fragmentWGSL
      const defs = definesOf(s.fragmentWGSL + s.vertexWGSL)
      const sets: Array<[string, string[]]> = [['none', []], ['all', defs]]
      for (const d of defs) sets.push([`only ${d}`, [d]], [`all but ${d}`, defs.filter(x => x !== d)])
      for (const [label, set] of sets) {
        const { frag: f, vert: v } = await buildShaderMaterial(engine, id, [...set, ...(s.extra ?? [])])
        expect(f.length, `${name} ${label} compiled`).toBeGreaterThan(0)
        const fa = analyze(f)
        expect(fa.diagnosticOff, `${name} ${label}: no diagnostic hides anything`).toBe(false)
        expectClean(`${name} ${label} (fragment)`, fa)
        expectClean(`${name} ${label} (vertex)`, analyze(v))
      }
    } finally {
      engine.dispose()
    }
  }, 120_000)
})

// ---- PBR / Standard with the plugins -----------------------------------------------------------------------------

describe('assembled WGSL: PBR / Standard materials with the plugins, every plugin define set', () => {
  for (const shadows of [false, true]) {
    const tag = shadows ? 'with the CSM (Babylon turns the analysis off)' : 'without shadows (analysis on: Low, far meshes, no receiver)'
    it.each(FAMILIES.map(f => f.name))(`%s, ${tag}`, async name => {
      const fam = FAMILIES.find(f => f.name === name)!
      const r = rig(shadows)
      try {
        const mesh = fam.make(r)
        mesh.receiveShadows = shadows
        for (const [label, f] of fam.sets) {
          force = f
          const b = await compileMesh(mesh)
          expect(b, `${name} ${label} compiled`).not.toBeNull()
          expect(b!.code.length, `${name} ${label}: a whole material fragment`).toBeGreaterThan(10_000)
          const a = analyze(b!.code)
          expect(a.diagnosticOff, `${name} ${label}: Babylon's diagnostic follows SHADOWS`).toBe(shadows)
          // live check: with the CSM the analysis finds Babylon's own PCF taps (which its diagnostic allows)
          if (shadows) expect(a.violations.length, `${name} ${label}: sees Babylon's CSM taps`).toBeGreaterThan(0)
          expectClean(`${name} ${label}`, a)
        }
      } finally {
        force = {}
        r.engine.dispose()
      }
    }, 180_000)

    it(`terrain PBR (SroTerrainPlugin), every preset x weather level and each feature, ${tag}`, async () => {
      const { r, pbr, mesh } = terrainRig(shadows)
      try {
        force = {}
        for (const [label, f] of terrainFeatureSets()) {
          pbr.setFeatures(f)
          const b = await compileMesh(mesh)
          expect(b, `terrain ${label} compiled`).not.toBeNull()
          const a = analyze(b!.code)
          expect(a.diagnosticOff).toBe(shadows)
          if (shadows) expect(a.violations.length).toBeGreaterThan(0)
          expectClean(`terrain ${label}`, a)
        }
      } finally {
        r.engine.dispose()
      }
    }, 180_000)
  }

  it('the Babylon contexts the presets add: cloth sheen, skin translucency, clustered lights (with the sheen patch), alpha test, specular AA', async () => {
    installShaderFixes()
    for (const cls of ['cloth', 'skin', 'stone', 'metal'] as const) {
      for (const cluster of [false, true]) {
        const r = rig(false)
        try {
          if (cluster) {
            const c = new ClusteredLightContainer('nl:cluster', [], r.scene)
            expect(c.isSupported).toBe(true)
            for (let i = 0; i < 4; i++) {
              const l = new PointLight(`nl:light${i}`, new Vector3(0, 1, 0), r.scene)
              l.range = 10
              c.addLight(l)
            }
          }
          const mat = new PBRMaterial(`${cls}_mat`, r.scene)
          mat.albedoTexture = r.tex
          mat.bumpTexture = r.tex
          mat.metallicTexture = r.tex
          mat.useRoughnessFromMetallicTextureGreen = true
          mat.useMetallnessFromMetallicTextureBlue = true
          mat.ambientTexture = r.tex
          mat.emissiveTexture = r.tex
          mat.enableSpecularAntiAliasing = true
          mat.useGLTFLightFalloff = true
          if (cls === 'cloth') {
            mat.sheen.isEnabled = true
            mat.sheen.color = new Color3(1, 1, 1)
          }
          if (cls === 'skin') mat.subSurface.isTranslucencyEnabled = true
          if (cls === 'metal') {
            mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
            mat.useAlphaFromAlbedoTexture = true
          }
          new SroSurfacePlugin(mat, new SurfaceShared(), { cls })
          attachFogPlugin(mat, new HeightFog(r.scene))
          const mesh = MeshBuilder.CreateBox(cls, {}, r.scene)
          mesh.material = mat
          force = { SRO_SURFACE: true, SRO_LUMA_ROUGH: true, SRO_WET: true, SRO_PUDDLES: true, SRO_LAMP: true, SRO_SELFLIT: true, SRO_HEIGHTFOG: true }
          const b = await compileMesh(mesh)
          expect(b, `${cls} cluster=${cluster}`).not.toBeNull()
          if (cluster) expect(b!.defines).toMatch(/#define CLUSTLIGHT_BATCH [1-9]/)
          const a = analyze(b!.code)
          expect(a.diagnosticOff).toBe(false)
          expectClean(`${cls} cluster=${cluster}`, a)
        } finally {
          force = {}
          r.engine.dispose()
        }
      }
    }
  }, 180_000)

  it('the foliage ShadowDepthWrapper strips SHADOWS (and so the diagnostic) and stays uniform', async () => {
    const r = rig(false)
    try {
      const created: Effectish[] = []
      const orig = r.engine.createEffect.bind(r.engine) as (...a: unknown[]) => unknown
      ;(r.engine as unknown as { createEffect: unknown }).createEffect = (...a: unknown[]) => {
        const e = orig(...a) as Effectish
        created.push(e)
        return e
      }
      const sg = new ShadowGenerator(256, r.sun)
      const mat = new PBRMaterial('tre_leaf', r.scene)
      mat.albedoTexture = r.tex
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage' })
      const fol = new SroFoliagePlugin(mat, new FoliageShared(), { leaf: true, kind: 'static' })
      attachFogPlugin(mat, new HeightFog(r.scene))
      const mesh = MeshBuilder.CreateBox('leaf', {}, r.scene)
      mesh.receiveShadows = true
      mesh.material = mat
      sg.addShadowCaster(mesh)
      fol.syncWrapper(true)
      force = { SRO_SURFACE: true, SRO_FOLIAGE: true, SRO_FOL_WIND: true, SRO_FOL_FLUTTER: true, SRO_FOL_TRANSL: true, SRO_WET: true, SRO_PUDDLES: true, SRO_HEIGHTFOG: true }
      expect(await compileMesh(mesh)).not.toBeNull()
      let ready = false
      for (let i = 0; i < 200 && !ready; i++) {
        r.scene.incrementRenderId()
        ready = sg.isReady(mesh.subMeshes[0]!, false, false)
        if (!ready) await new Promise(res => setTimeout(res, 3))
      }
      expect(ready).toBe(true)
      const depth = created.filter(e => e._fragmentSourceCode && /depthSM/.test(e._fragmentSourceCode))
      expect(depth.length).toBeGreaterThan(0)
      for (const e of depth) {
        const a = analyze(e._fragmentSourceCode)
        expect(a.diagnosticOff, 'the wrapper removes #define SHADOWS').toBe(false)
        expect(a.violations.map(describeV)).toEqual([])
      }
    } finally {
      force = {}
      r.engine.dispose()
    }
  }, 120_000)

  it('the post pipelines of render/post.ts (FSR1, SSAO2, SSR, TAA, default pipeline, light shafts)', async () => {
    const r = rig(false)
    try {
      const created: Effectish[] = []
      const orig = r.engine.createEffect.bind(r.engine) as (...a: unknown[]) => unknown
      ;(r.engine as unknown as { createEffect: unknown }).createEffect = (...a: unknown[]) => {
        const e = orig(...a) as Effectish
        created.push(e)
        return e
      }
      const scene = r.scene
      const camera = scene.activeCamera!
      const half = Constants.TEXTURETYPE_HALF_FLOAT
      new FSR1RenderingPipeline('sroFsr', scene, [camera]).scaleFactor = 1.5
      new SSAO2RenderingPipeline('sroSsao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [camera], false, half).expensiveBlur = true
      const ssr = new SSRRenderingPipeline('sroSsr', scene, [camera], false, half)
      ssr.attenuateScreenBorders = true
      ssr.attenuateFacingCamera = true
      const taa = new TAARenderingPipeline('sroTaa', scene, [camera], half)
      taa.reprojectHistory = true
      taa.clampHistory = true
      const dp = new DefaultRenderingPipeline('sroPost', true, scene, [camera], false)
      dp.fxaaEnabled = true
      dp.bloomEnabled = true
      dp.sharpenEnabled = true
      dp.prepare()
      new VolumetricLightScatteringPostProcess('sroShafts', 0.5, camera, MeshBuilder.CreatePlane('sun', {}, scene), 64, Texture.BILINEAR_SAMPLINGMODE, r.engine, false)
      for (let i = 0; i < 100 && created.some(e => !e._fragmentSourceCode); i++) await new Promise(res => setTimeout(res, 5))
      const built = created.filter(e => e._fragmentSourceCode)
      expect(built.length).toBeGreaterThan(20)
      for (const e of built) expectClean('post', analyze(e._fragmentSourceCode))
    } finally {
      r.engine.dispose()
    }
  }, 120_000)
})

// ---- what the textual guards cannot see ------------------------------------------------------------------------

describe('the textual guards vs the assembled check (documents the gap; both pass today)', () => {
  it('terrain-plugin.test.ts\'s rule accepts a derivative inside the per-pixel parallax branch; the assembled check does not', async () => {
    // A plausible edit: an implicit-derivative tap inside `if (camD < 20.0)` (the parallax march).
    const mutate = (code: string) => code.replace('var depth = 0.0;', 'var depth = 0.0;\n    let pg = dpdx(camD) + textureSampleBias(sroLightmap, sroLightmapSampler, lp / 20.0, 0.0).r;')
    // terrain-plugin.test.ts 'WGSL: every derivative and implicit-LOD tap comes before the layer loop', verbatim
    const def = mutate(terrainPluginCode('wgsl').CUSTOM_FRAGMENT_DEFINITIONS!)
    expect(def).toContain('let pg = dpdx(camD)')
    const body = def.slice(def.indexOf('fn sroTerrainEval()'))
    const loop = body.indexOf('for (var k = 0;')
    expect(loop).toBeGreaterThan(0)
    expect(body.slice(loop)).not.toMatch(/\bdpd[xy]\(|\btextureSample\(|\btextureSampleBias\(/)
    expect(body.slice(0, loop).replace(/textureSampleGrad|textureSampleLevel/g, '')).not.toMatch(/textureSample\(/)
    // the same edit in the assembled Ultra-like shader (parallax on, no CSM): both taps are rejected
    const { r, pbr, mesh } = terrainRig(false)
    try {
      const none = Object.fromEntries(TERRAIN_FEATURES.map(k => [k, false])) as unknown as TerrainFeatures
      pbr.setFeatures({ ...none, ormh: true, parallax: true })
      force = {}
      const b = await compileMesh(mesh)
      expect(b).not.toBeNull()
      expect(analyze(b!.code).violations).toEqual([])
      expect(analyze(mutate(b!.code)).violations.map(v => v.op).sort()).toEqual(['dpdx', 'textureSampleBias'])
    } finally {
      r.engine.dispose()
    }
  }, 60_000)

  it('the plugin guards\' regexes (pbr-plugins, water-pbr, foliage, fog, weather-shaders) miss textureSampleBias / textureSampleCompare', () => {
    const tap = 'if (fragmentInputs.vPositionW.y > 0.0) { surfaceAlbedo = textureSampleBias(sroWaterNormal, sroWaterNormalSampler, fragmentInputs.vPositionW.xz, 0.0).rgb; }'
    for (const guard of [/\bdpdx|dpdy|fwidth|textureSample\(/, /textureSample\(/, /\btextureSample\s*\(/]) expect(guard.test(tap), String(guard)).toBe(false)
    expect(analyze(frag(`var surfaceAlbedo = vec3f(0.0);\n${tap.replace(/sroWaterNormal(Sampler)?/g, (_m, g1) => (g1 ? 's' : 't')).replace(/fragmentInputs\.vPositionW/g, 'vec3f(uv, 0.0)')}\nreturn vec4f(surfaceAlbedo, 1.0);`)).violations.map(v => v.op)).toEqual(['textureSampleBias'])
    // the real water code keeps every tap at the top of main, so it passes both
    expect(waterFragmentCode('wgsl').CUSTOM_FRAGMENT_UPDATE_ALBEDO).not.toMatch(/textureSample/)
  })
})

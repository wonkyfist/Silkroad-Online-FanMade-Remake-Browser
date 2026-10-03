/**
 * The birds (docs/GRASS_LIFE.md §5.3; lane GL-L): one mesh and one draw for every bird (GL-S's 17-triangle songbird,
 * per-species colours and scale), flown on the CPU by life/flock.ts. A director (4 times a second) keeps §5.1's
 * numbers around the focus:
 *
 * - **Ground flocks** (sparrows, 8–16 birds; two by day, one at dawn and dusk; none at night, in rain, or with
 *   `configure({ groundFlocks: false })`): they fly in, circle, land in open grass 14–24 m from the player and away from
 *   every actor (life/spawn.ts findLanding: density ≥ 0.5, no object floor, no water, so never inside the town's
 *   paving), peck and hop, and **flush when anyone comes within 9 m** (the first bird within 0.25 s, all within
 *   0.6 s), circle away and land somewhere else after 20–40 s.
 * - **Roof perchers** (magpies and crows in pairs, 6 on Medium, 10 on High, within 40 m): they fly in and sit on the
 *   ridge points of the building placements (life/spawn.ts perchPointsOf); a threat within 6 m flushes them to another
 *   ridge.
 * - **Fly-overs** every 30–90 s: swallows over the fields (also at dusk), egrets over inland water.
 * - **Registered species** (the coast's gulls, CST-A): a species whose habitat is not built in lives in the habitat
 *   registered under its id: it circles over the best-weighted spot around the focus and loafs where the habitat's
 *   `landing` says, flushing like the ground flocks.
 * Rain, wind and night send them away (up and out); a flock that is far behind the player is retired at once.
 */
import type { LifeMesh, LifeTargets } from './life.ts'
import { BIRD_STRIDE, Flock, FlyOver, flockRandom, type FlockGround, type FlockOptions } from './flock.ts'
import { packRgb } from './shaders.ts'
import { LANDING_CLEAR_M, findLanding, type LifeGround, type LifePlaces } from './spawn.ts'
import type { LifeFlush, LifeHabitat, LifeSpecies, LifeThreat } from './types.ts'

/** The bird mesh's capacity (two flocks of 16, ten perchers, a fly-over and the coast's gulls fit with room). */
export const MAX_BIRDS = 96
/** The director's period (s). */
export const DIRECTOR_S = 0.25
/** Perchers sit within this of the focus (m) and leave beyond PERCH_DROP_M. */
export const PERCH_RANGE_M = 40
const PERCH_DROP_M = 60
/** A percher flushes when a threat comes this close (m, 3D): people walk under the eaves. */
export const PERCH_FLUSH_M = 6
/** Flocks this far from the focus are retired at once (m); leaving ones beyond LEAVE_DROP_M or after LEAVE_DROP_S. */
const RETIRE_M = 140
const LEAVE_DROP_M = 80
const LEAVE_DROP_S = 25

/** Display sRGB (0..255) to the linear colours LifeSpecies carries. */
function lin(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [f(r), f(g), f(b)]
}
/** Linear 0..1 to display sRGB 0..255. */
function srgb(c: number): number {
  const v = Math.max(0, Math.min(1, c))
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
}

/**
 * The built-in birds (GRASS_LIFE §5.3, §11 item 7): `colors` = (the dark back and wings, the light belly), linear.
 * Scales are readable at game distance like the butterflies' (the prototype's sparrow is 1.3).
 */
export const BUILTIN_BIRDS: readonly LifeSpecies[] = [
  { id: 'sparrow', kind: 'bird', habitat: 'meadow', colors: [lin(52, 38, 27), lin(158, 140, 116)], scale: 1.3, flap: { hz: 2.6, amplitude: 1 }, max: 16 },
  { id: 'magpie', kind: 'bird', habitat: 'roof', colors: [lin(18, 20, 28), lin(232, 232, 228)], scale: 2, flap: { hz: 2.2, amplitude: 0.9 }, max: 10 },
  { id: 'crow', kind: 'bird', habitat: 'roof', colors: [lin(16, 16, 20), lin(46, 46, 54)], scale: 2.2, flap: { hz: 1.8, amplitude: 0.85 }, max: 10 },
  { id: 'swallow', kind: 'bird', habitat: 'fields', colors: [lin(22, 28, 60), lin(228, 214, 198)], scale: 1.15, flap: { hz: 3.2, amplitude: 1 }, max: 7 },
  { id: 'egret', kind: 'bird', habitat: 'water', colors: [lin(214, 214, 206), lin(246, 246, 240)], scale: 2.6, flap: { hz: 1.2, amplitude: 0.8 }, max: 3 },
]

export type BirdRole = 'ground' | 'perch' | 'fields' | 'water' | 'habitat'

/** A bird species as the director flies it. */
export interface BirdSpecies {
  id: string
  habitat: string
  role: BirdRole
  scale: number
  /** Packed display colours for the shader (life/shaders.ts packRgb). */
  dark: number
  light: number
  flapHz: number
  amp: number
  max: number
}

const ROLES: Record<string, BirdRole> = { meadow: 'ground', roof: 'perch', fields: 'fields', water: 'water' }

/** A LifeSpecies of kind 'bird' as the director flies it; a habitat not in `builtins` makes it a habitat flock. */
export function birdSpeciesOf(s: LifeSpecies, builtins: readonly string[]): BirdSpecies {
  const habitat = s.habitat ?? 'meadow'
  const role: BirdRole = builtins.includes(habitat) ? ROLES[habitat] ?? 'ground' : 'habitat'
  const [d, l] = [s.colors?.[0], s.colors?.[1] ?? s.colors?.[0]]
  return {
    id: s.id, habitat, role,
    scale: s.scale ?? 1.3,
    dark: d ? packRgb(srgb(d[0]), srgb(d[1]), srgb(d[2])) : 0,
    light: l ? packRgb(srgb(l[0]), srgb(l[1]), srgb(l[2])) : 0,
    flapHz: s.flap?.hz ?? 2.6,
    amp: s.flap?.amplitude ?? 1,
    max: Math.max(1, Math.min(24, s.max ?? 12)),
  }
}

/** What the director reads each frame (WorldLife keeps one and refreshes it). */
export interface BirdContext {
  ground: LifeGround
  places: LifePlaces
  focus: { x: number; y: number; z: number }
  threats: readonly LifeThreat[]
  targets: LifeTargets
  species: BirdSpecies[]
  habitat(id: string): LifeHabitat | null
  flush(f: LifeFlush): void
}

interface FlockEntry {
  role: BirdRole
  species: BirdSpecies
  flock: Flock
  /** The perch (perchers) or the habitat id (habitat flocks). */
  perch: [number, number, number] | null
  habitatT: number
}

interface PassEntry {
  species: BirdSpecies
  pass: FlyOver
}

const GROUND_FLOCK: FlockOptions = { circleRadiusM: 14, circleHeightM: 15, flushM: 9, spreadM: 0.7, hops: true, circleS: [20, 40] }
const PERCH_FLOCK: FlockOptions = { circleRadiusM: 6, circleHeightM: 7, flushM: PERCH_FLUSH_M, spreadM: 0.3, hops: false, circleS: [5, 10] }
const HABITAT_FLOCK: FlockOptions = { circleRadiusM: 16, circleHeightM: 14, flushM: 9, spreadM: 0.9, hops: false, circleS: [25, 45] }

export class LifeBirds {
  private readonly flocks: FlockEntry[] = []
  private readonly passes: PassEntry[] = []
  private readonly rnd: () => number
  private directorT = 0
  private passT: number
  private groundCooldown = 0
  private seeds: number
  private ctxGround: LifeGround | null = null
  /** Flying birds stay above the terrain and any water (the sea included). */
  private readonly surface: FlockGround = { heightAt: (x, z) => this.ctxGround?.surfaceAt(x, z) ?? null }

  constructor(readonly mesh: LifeMesh, seed: number) {
    this.rnd = flockRandom(seed)
    this.seeds = seed
    this.passT = 8 + this.rnd() * 20
  }

  /** Any bird in the air or on the ground. */
  active(): boolean {
    return this.flocks.length > 0 || this.passes.length > 0
  }

  flockCount(): number {
    return this.flocks.length
  }

  /** The flocks now (tests, the viewer's panel). */
  flocksOf(role?: BirdRole): Flock[] {
    return this.flocks.filter(e => !role || e.role === role).map(e => e.flock)
  }

  /** Birds of `role` (or all) in the air or on the ground, not counting the leaving ones. */
  birdsOf(role?: BirdRole): number {
    let n = 0
    for (const e of this.flocks) if ((!role || e.role === role) && e.flock.state !== 'leave') n += e.flock.n
    if (!role || role === 'fields' || role === 'water') for (const p of this.passes) if (!role || p.species.role === role) n += p.pass.n
    return n
  }

  /** Every bird goes at once (the part switched off, disposed). */
  clear(): void {
    this.flocks.length = 0
    this.passes.length = 0
    this.mesh.commit(0)
  }

  /** The flocks of a role go at once (configure({ groundFlocks: false })). */
  dropRole(role: BirdRole): void {
    for (let i = this.flocks.length - 1; i >= 0; i--) if (this.flocks[i]!.role === role) this.flocks.splice(i, 1)
  }

  /** A species' birds go at once (its remover). */
  dropSpecies(id: string): void {
    for (let i = this.flocks.length - 1; i >= 0; i--) if (this.flocks[i]!.species.id === id) this.flocks.splice(i, 1)
    for (let i = this.passes.length - 1; i >= 0; i--) if (this.passes[i]!.species.id === id) this.passes.splice(i, 1)
  }

  update(dt: number, ctx: BirdContext): void {
    this.ctxGround = ctx.ground
    this.directorT -= dt
    if (this.directorT <= 0) {
      this.directorT = DIRECTOR_S
      this.direct(ctx)
    }
    const buf = this.mesh.buf
    let k = 0
    for (const e of this.flocks) {
      const f = e.flock
      f.update(dt, ctx.threats, this.surface)
      if (f.flushed) ctx.flush({ x: f.spot[0]!, y: f.spot[1]!, z: f.spot[2]!, count: f.n })
      if (k + f.n <= MAX_BIRDS) k += f.write(buf, k * BIRD_STRIDE, e.species.scale, e.species.dark, e.species.light, e.species.amp)
    }
    for (const p of this.passes) {
      p.pass.update(dt, this.surface)
      if (k + p.pass.n <= MAX_BIRDS) k += p.pass.write(buf, k * BIRD_STRIDE, p.species.scale, p.species.dark, p.species.light, p.species.amp)
    }
    this.mesh.commit(k)
  }

  private free(n: number): boolean {
    let used = 0
    for (const e of this.flocks) used += e.flock.n
    for (const p of this.passes) used += p.pass.n
    return used + n <= MAX_BIRDS
  }

  private pick(ctx: BirdContext, role: BirdRole): BirdSpecies | null {
    let n = 0
    for (const s of ctx.species) if (s.role === role) n++
    if (!n) return null
    let k = Math.floor(this.rnd() * n)
    for (const s of ctx.species) if (s.role === role && k-- === 0) return s
    return null
  }

  private nextSeed(): number {
    this.seeds = (Math.imul(this.seeds ^ 0x5bd1e995, 0x27d4eb2d) + 0x165667b1) >>> 0
    return this.seeds
  }

  /** Where a flock leaves to: away from the focus. */
  private leave(e: FlockEntry, ctx: BirdContext): void {
    e.flock.leave(e.flock.mean[0]! - ctx.focus.x + 0.1, e.flock.mean[2]! - ctx.focus.z)
  }

  private direct(ctx: BirdContext): void {
    const f = ctx.focus
    const t = ctx.targets
    this.groundCooldown -= DIRECTOR_S
    // Retire what is far away or has left.
    for (let i = this.flocks.length - 1; i >= 0; i--) {
      const fl = this.flocks[i]!.flock
      const d = Math.hypot(fl.mean[0]! - f.x, fl.mean[2]! - f.z)
      if (d > RETIRE_M || (fl.state === 'leave' && (d > LEAVE_DROP_M || fl.stateT > LEAVE_DROP_S))) this.flocks.splice(i, 1)
    }
    for (let i = this.passes.length - 1; i >= 0; i--) if (this.passes[i]!.pass.done) this.passes.splice(i, 1)
    this.directGround(ctx, t.groundFlocks)
    this.directPerchers(ctx, t.perchers)
    this.directPasses(ctx, t.flyOvers)
    this.directHabitats(ctx, t.habitatFlocks)
  }

  private directGround(ctx: BirdContext, want: number): void {
    const f = ctx.focus
    let have = 0
    for (const e of this.flocks) {
      if (e.role !== 'ground' || e.flock.state === 'leave') continue
      have++
      if (have > want) {
        this.leave(e, ctx)
        continue
      }
      const fl = e.flock
      if (fl.state === 'circle') {
        // Keep the circling flock around the player.
        const dx = f.x - fl.centre[0]!, dz = f.z - fl.centre[2]!
        if (Math.hypot(dx, dz) > 45) fl.setCentre(fl.centre[0]! + dx * 0.3, fl.centre[1]!, fl.centre[2]! + dz * 0.3)
        if (fl.wantsLanding()) {
          const spot = findLanding(ctx.ground, this.rnd, f.x, f.z, ctx.threats)
          if (spot) fl.land(spot.x, spot.y, spot.z, ctx.ground)
          else fl.postpone(8)
        }
      }
    }
    if (have >= want || this.groundCooldown > 0) return
    const species = this.pick(ctx, 'ground')
    if (!species) return
    const n = Math.min(species.max, 8 + Math.floor(this.rnd() * 9))
    if (!this.free(n)) return
    // Fly in from 45 m away, 15 m up, and land soon (the first landing does not wait the full 20–40 s).
    const a = this.rnd() * Math.PI * 2
    const x = f.x + Math.cos(a) * 45, z = f.z + Math.sin(a) * 45
    const flock = new Flock(n, this.nextSeed(), { ...GROUND_FLOCK, flapHz: species.flapHz })
    flock.spawnCircle(x, (ctx.ground.surfaceAt(x, z) ?? f.y) + 15, z)
    flock.postpone(6 + this.rnd() * 8)
    this.flocks.push({ role: 'ground', species, flock, perch: null, habitatT: 0 })
    this.groundCooldown = 8
  }

  /** A free ridge point near the focus (not within 4 m of another percher's), or null. */
  private freePerch(ctx: BirdContext): [number, number, number] | null {
    const f = ctx.focus
    const found: Array<[number, number, number]> = []
    ctx.places.perches.near(f.x, f.z, PERCH_RANGE_M, (x, y, z) => {
      for (const e of this.flocks) if (e.perch && Math.hypot(e.perch[0] - x, e.perch[2] - z) < 4) return
      found.push([x, y, z])
    })
    return found.length ? found[Math.floor(this.rnd() * found.length)]! : null
  }

  private directPerchers(ctx: BirdContext, want: number): void {
    const f = ctx.focus
    let have = 0
    for (const e of this.flocks) {
      if (e.role !== 'perch' || e.flock.state === 'leave') continue
      const p = e.perch
      if ((p && Math.hypot(p[0] - f.x, p[2] - f.z) > PERCH_DROP_M) || have >= want) {
        this.leave(e, ctx)
        continue
      }
      have += e.flock.n
      if (e.flock.wantsLanding()) {
        e.perch = null
        const next = this.freePerch(ctx)
        if (next) {
          e.perch = next
          e.flock.land(next[0], next[1], next[2], null, true)
        } else this.leave(e, ctx)
      }
    }
    if (have >= want - 1) return
    const species = this.pick(ctx, 'perch')
    const perch = species ? this.freePerch(ctx) : null
    if (!species || !perch) return
    const n = Math.min(2, want - have, species.max)
    if (n <= 0 || !this.free(n)) return
    const flock = new Flock(n, this.nextSeed(), { ...PERCH_FLOCK, flapHz: species.flapHz })
    // Fly in from 30 m away and 10 m above the ridge.
    const a = this.rnd() * Math.PI * 2
    flock.spawnCircle(perch[0] + Math.cos(a) * 30, perch[1] + 10, perch[2] + Math.sin(a) * 30)
    flock.land(perch[0], perch[1], perch[2], null, true)
    this.flocks.push({ role: 'perch', species, flock, perch, habitatT: 0 })
  }

  private directPasses(ctx: BirdContext, mode: LifeTargets['flyOvers']): void {
    this.passT -= DIRECTOR_S
    if (this.passT > 0) return
    this.passT = 30 + this.rnd() * 60
    if (mode === 'none' || this.passes.length) return
    const f = ctx.focus
    // Egrets over inland water when some is near by day, else swallows over the fields.
    let water: { x: number; z: number } | null = null
    if (mode === 'any') {
      for (let k = 0; k < 12 && !water; k++) {
        const a = this.rnd() * Math.PI * 2, d = 10 + this.rnd() * 50
        const x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d
        if (ctx.ground.waterAt(x, z) !== null) water = { x, z }
      }
    }
    const species = (water ? this.pick(ctx, 'water') : null) ?? this.pick(ctx, 'fields')
    if (!species) return
    const egret = species.role === 'water'
    const n = Math.min(species.max, egret ? 1 + Math.floor(this.rnd() * 3) : 3 + Math.floor(this.rnd() * 5))
    if (!this.free(n)) return
    const cx = water && egret ? water.x : f.x + (this.rnd() - 0.5) * 40
    const cz = water && egret ? water.z : f.z + (this.rnd() - 0.5) * 40
    const a = this.rnd() * Math.PI * 2
    const pass = new FlyOver(n, this.nextSeed(), cx, cz, Math.cos(a), Math.sin(a), {
      heightM: egret ? 14 + this.rnd() * 8 : 12 + this.rnd() * 6, speedMs: egret ? 6 : 11, flapHz: species.flapHz, halfLengthM: 90,
    })
    this.passes.push({ species, pass })
  }

  private directHabitats(ctx: BirdContext, allowed: boolean): void {
    const f = ctx.focus
    for (const species of ctx.species) {
      if (species.role !== 'habitat') continue
      const rule = ctx.habitat(species.habitat)
      const entry = this.flocks.find(e => e.species === species && e.flock.state !== 'leave')
      if (entry && (!rule || !allowed)) {
        this.leave(entry, ctx)
        continue
      }
      if (!rule || !allowed) continue
      if (entry) {
        const fl = entry.flock
        entry.habitatT -= DIRECTOR_S
        if (entry.habitatT <= 0 && fl.state === 'circle') {
          entry.habitatT = 2
          if (!(rule.weight(fl.centre[0]!, fl.centre[2]!) > 0.05)) {
            const best = this.bestHabitat(rule, f)
            if (best) fl.setCentre(best.x, (ctx.ground.surfaceAt(best.x, best.z) ?? f.y) + HABITAT_FLOCK.circleHeightM!, best.z)
            else this.leave(entry, ctx)
          }
        }
        if (fl.wantsLanding()) {
          const spot = rule.landing ? this.habitatLanding(rule, fl.centre[0]!, fl.centre[2]!, ctx.threats) : null
          if (spot) fl.land(spot.x, spot.y, spot.z, null, true)
          else fl.postpone(15)
        }
        continue
      }
      const best = this.bestHabitat(rule, f)
      if (!best) continue
      const n = Math.min(species.max, 10)
      if (!this.free(n)) continue
      // W11-S (TOWN_LIFE §4): a habitat whose landing is water (`float`) floats and bobs instead of loafing.
      const flock = new Flock(n, this.nextSeed(), rule.float ? { ...HABITAT_FLOCK, flapHz: species.flapHz, float: true } : { ...HABITAT_FLOCK, flapHz: species.flapHz })
      flock.spawnCircle(best.x, (ctx.ground.surfaceAt(best.x, best.z) ?? f.y) + HABITAT_FLOCK.circleHeightM!, best.z)
      this.flocks.push({ role: 'habitat', species, flock, perch: null, habitatT: 2 })
    }
  }

  /** The best-weighted of 16 samples around the focus (weight > 0.2), or null. */
  private bestHabitat(rule: LifeHabitat, f: { x: number; z: number }): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null
    let bw = 0.2
    for (const r of [25, 50, 75]) {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + r * 0.013
        const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r
        const w = rule.weight(x, z)
        if (w > bw) {
          bw = w
          best = { x, z }
        }
      }
    }
    return best
  }

  /** A loafing spot the habitat allows near (x, z), clear of every threat, or null. */
  private habitatLanding(rule: LifeHabitat, x0: number, z0: number, threats: readonly LifeThreat[]): { x: number; y: number; z: number } | null {
    for (let k = 0; k < 12; k++) {
      const a = this.rnd() * Math.PI * 2, d = this.rnd() * 30
      const x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d
      if (!(rule.weight(x, z) > 0)) continue
      const y = rule.landing!(x, z)
      if (y === null || !Number.isFinite(y)) continue
      if (threats.some(t => (t.x - x) ** 2 + (t.z - z) ** 2 < LANDING_CLEAR_M * LANDING_CLEAR_M)) continue
      return { x, y, z }
    }
    return null
  }
}

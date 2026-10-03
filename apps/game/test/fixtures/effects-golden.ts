/**
 * The golden table of the H1 retail harness (docs/EFFECTS.md §2.5): what the retail data says each skill shows, built
 * from the data alone (work/out/data/skills.json rows, fx index v2 stage rows, the adventurer sidecar's clips), not
 * from the game code under test. Per active level-1 row at or below the level cap (the 34 lines + 3 basic attacks)
 * and model: the phases (SKILLS.md §5.1 timing, clip resolved aniGroup -> default by TYPE_NAME) and every stage row
 * with its start time (phase start + the clip's N-th type-1 event), anchor, bone, caster-local offset, loop / Kill /
 * Trade.
 */

/** Level cap of the build (docs/WAVE_PLAN2.md). */
export const GOLDEN_CAP = 20

export interface GoldenPhase {
  phase: 'READY' | 'WAIT' | 'SHOT'
  type: string
  clipName: string | null
  startMs: number
  ms: number
  loop: boolean
  /** Sorted type-1 events of the clip (ms from its start). */
  events: number[]
}

export type GoldenAnchor = 'bone' | 'root' | 'damagePos' | 'target' | 'flight'

export interface GoldenStage {
  phase: string
  /** Particles key, the .bsr model glb, or null (a Kill row without an effect). */
  key: string | null
  /** Local ms after the cast (DMG rows: their hit cue's time). */
  atMs: number
  anchor: GoldenAnchor
  bone: string | null
  /** Caster-local offset, glTF metres (x, y, -z) x 0.1. */
  offsetM: [number, number, number]
  targetOffsetM: [number, number, number]
  roll: number
  loop: boolean
  dmg: boolean
  killId: number
  trade: number
  id: number
  model: boolean
}

export interface GoldenRow {
  code: string
  group: string
  kind: string
  basic: boolean
  instant: boolean
  /** Ranged rows (range > 5 m): the target stands 12 m away, else 3 m. */
  ranged: boolean
  prepareMs: number
  castMs: number
  actionMs: number
  phases: GoldenPhase[]
  stages: GoldenStage[]
  /** Hit cues (phase, event) and their local ms. */
  cues: { phase: string; event: number; atMs: number }[]
}

interface SkillRow {
  code: string
  group?: string
  kind?: string
  masteryLevel: number
  skillLevel: number
  basicAttack?: boolean
  instant?: boolean
  chainIndex?: number
  range: number
  preparingMs?: number
  castMs: number
  actionMs: number
  animation?: { ready?: string; wait?: string; shot?: string }
  aniGroup?: string
  hitCues?: { phase: string; event: number }[]
}

interface StageRow {
  phase: string
  startEvent: number
  actType: string
  effect: string | null
  startBone: string | null
  startOffset: string
  targetOffset: string
  rotate: string
  script: string | null
  dmg?: boolean
  kill?: number
  trade?: number
  id?: number
  objectModel?: { glb: string } | null
  move: string
}

interface GroupRow {
  group: string
  arrowTail: string | null
  stages: StageRow[]
}

interface ClipRow {
  name: string
  group: string
  typeName: string
  durationMs: number
  events: { timeMs: number; type: number }[]
}

const toM = (s: string): [number, number, number] => {
  const [x = 0, y = 0, z = 0] = s.split(',').map(n => (Number.isFinite(Number(n)) ? Number(n) : 0))
  return [x * 0.1, y * 0.1, z ? -z * 0.1 : 0]
}

const roll = (rotate: string, script: string | null): number => {
  let v = Number(rotate)
  if (!Number.isFinite(v) || v === 0) v = Number(/^SCT_RUT,(-?[\d.]+)/.exec(script ?? '')?.[1] ?? 0)
  if (!v) return 0
  return (((v >= 720 ? v - 720 : v) % 360) * Math.PI) / 180
}

const typeOf = (v: string | undefined): string | null => v?.split(',')[0]?.trim().replace(/^ANI_/, '') || null

/** The clip of TYPE_NAME `type` in `aniGroup` (lower case), else in 'default' (docs/SKILLS.md §6). */
export function resolveClip(clips: readonly ClipRow[], aniGroup: string | undefined, type: string): ClipRow | null {
  const g = (aniGroup ?? 'default').toLowerCase()
  return clips.find(c => c.group === g && c.typeName === type) ?? clips.find(c => c.group === 'default' && c.typeName === type) ?? null
}

const eventsOf = (c: ClipRow | null): number[] => (c ? c.events.filter(e => e.type === 1).map(e => e.timeMs).sort((a, b) => a - b) : [])

/** The rows the harness checks: active level-1 Chinese rows at or below the cap, chain heads only. */
export function goldenRows(skills: readonly SkillRow[]): SkillRow[] {
  return skills.filter(s => /^SKILL_CH_/.test(s.code) && s.skillLevel === 1 && s.masteryLevel <= GOLDEN_CAP && s.kind !== 'passive' && !((s.chainIndex ?? 1) > 1))
}

/** Builds the golden table for one model's clips. */
export function buildGolden(skills: readonly SkillRow[], groups: readonly GroupRow[], clips: readonly ClipRow[]): GoldenRow[] {
  const byGroup = new Map(groups.map(g => [g.group, g]))
  const out: GoldenRow[] = []
  for (const s of goldenRows(skills)) {
    const group = s.group ?? s.code.replace(/(_\dS)?_\d+$/, '')
    const g = byGroup.get(group)
    const prep = Math.max(0, s.preparingMs ?? 0)
    const cast = s.castMs > 1 ? s.castMs : 0
    const phases: GoldenPhase[] = []
    const add = (phase: GoldenPhase['phase'], type: string, start: number, ms: number, loop: boolean) => {
      const c = resolveClip(clips, s.aniGroup, type)
      phases.push({ phase, type, clipName: c?.name ?? null, startMs: start, ms, loop, events: eventsOf(c) })
    }
    const ready = typeOf(s.animation?.ready)
    const wait = typeOf(s.animation?.wait)
    const shot = typeOf(s.animation?.shot)
    let t = 0
    if (!s.instant) {
      if (prep > 0) {
        const waitOk = !!wait && cast > 0
        if (ready) {
          add('READY', ready, t, prep + (waitOk ? 0 : cast), false)
          t += prep + (waitOk ? 0 : cast)
        }
        if (waitOk) {
          const ms = ready ? cast : prep + cast
          add('WAIT', wait!, t, ms, true)
          t += ms
        }
      }
      if (shot) add('SHOT', shot, t, Math.max(1, prep > 0 ? s.actionMs : cast + s.actionMs), false)
    }
    const phaseOf = (p: string) => phases.find(x => x.phase === p)
    const cues = (s.hitCues ?? []).map(c => {
      const ph = phaseOf(c.phase) ?? phases[phases.length - 1]
      const ev = c.event > 0 ? ph?.events[c.event - 1] ?? 0 : 0
      return { phase: c.phase, event: c.event, atMs: (ph?.startMs ?? 0) + ev }
    })
    const stages: GoldenStage[] = []
    for (const r of g?.stages ?? []) {
      const ph = phaseOf(r.phase)
      if (!ph) continue
      const flight = r.actType.startsWith('AT_MOV_')
      const dmg = r.dmg === true && !flight
      const ev = r.startEvent > 0 ? ph.events[r.startEvent - 1] ?? 0 : 0
      const anchor: GoldenAnchor = flight ? 'flight' : r.actType === 'AT_DMG_POS' ? 'damagePos' : r.actType === 'AT_TARGET' ? 'target' : r.startBone ? 'bone' : 'root'
      const model = !!r.objectModel?.glb
      const key = r.effect ?? (model && !flight ? r.objectModel!.glb : flight ? (model ? r.objectModel!.glb : g!.arrowTail) : null)
      stages.push({
        phase: r.phase,
        key,
        atMs: ph.startMs + ev,
        anchor,
        bone: r.startBone,
        offsetM: toM(r.startOffset),
        targetOffsetM: toM(r.targetOffset),
        roll: roll(r.rotate, r.script),
        loop: r.actType === 'AT_LOOP',
        dmg,
        killId: r.kill ?? 0,
        trade: r.trade ?? 0,
        id: r.id ?? 0,
        model,
      })
    }
    out.push({
      code: s.code,
      group,
      kind: s.kind ?? 'attack',
      basic: !!s.basicAttack,
      instant: !!s.instant,
      ranged: s.range > 5,
      prepareMs: prep,
      castMs: s.castMs,
      actionMs: s.actionMs,
      phases,
      stages,
      cues,
    })
  }
  return out
}

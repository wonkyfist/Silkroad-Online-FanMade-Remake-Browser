/**
 * Voice limiting (docs/SOUND.md §5.5), pure: decides whether a new one-shot may start and which playing voices it
 * steals. No WebAudio here; GameAudio keeps the list of playing voices and asks before each start.
 */

export type VoiceBus = 'sfx' | 'ui' | 'ambient'

/** What a sound is, for the per-entity and distance rules. */
export type VoiceKind = 'step' | 'voice' | 'death' | 'idle' | 'other'

export interface VoiceRequest {
  bus: VoiceBus
  file: string
  kind: VoiceKind
  /** Owning entity id (clip tracks, hits); undefined for UI and ambience. */
  entity?: number
  /** Yourself 3, your target 2, other players 1, mobs/NPCs 0 (UI plays on its own bus). */
  priority: number
  /** Metres from the listener (0 for non-spatial). */
  distance: number
  /** Your own sounds are never culled by distance. */
  self: boolean
  /** Ambient loops are not counted as one-shots. */
  loop?: boolean
}

export interface ActiveVoice extends VoiceRequest {
  id: number
  startedAt: number
}

export type Admission = { ok: true; steal: number[] } | { ok: false; reason: 'culled' | 'retrigger' | 'busy' | 'voice' }

export const VOICE_LIMITS = {
  total: 32,
  bus: { sfx: 24, ui: 4, ambient: 6 } as Record<VoiceBus, number>,
  sameFile: 4,
  entitySfx: 2,
  retriggerMs: 60,
  /** Distance culls for sounds of others (metres). */
  cull: { step: 20, idle: 15, voice: 30, death: 30, other: 40 } as Record<VoiceKind, number>,
}

const isVoice = (k: VoiceKind) => k === 'voice' || k === 'death'

/** Lower = stolen first: lowest priority, then the farthest, then the oldest. */
function stealOrder(a: ActiveVoice, b: ActiveVoice): number {
  return a.priority - b.priority || b.distance - a.distance || a.startedAt - b.startedAt
}

/** true when `req` ranks above `v` (so it may take its place). */
function outranks(req: VoiceRequest, v: ActiveVoice): boolean {
  if (req.priority !== v.priority) return req.priority > v.priority
  if (req.distance !== v.distance) return req.distance < v.distance
  return true // same rank: the new sound replaces the older one
}

export class VoicePolicy {
  constructor(private readonly limits = VOICE_LIMITS) {}

  /** May `req` start at `now` (ms) given the playing `active` voices? On ok, stop the `steal` ids first. */
  admit(req: VoiceRequest, active: readonly ActiveVoice[], now: number): Admission {
    const L = this.limits
    if (!req.self && req.distance > (L.cull[req.kind] ?? L.cull.other)) return { ok: false, reason: 'culled' }
    const steal = new Set<number>()
    const live = () => active.filter(v => !steal.has(v.id))
    if (req.entity !== undefined) {
      const mine = active.filter(v => v.entity === req.entity)
      if (mine.some(v => v.file === req.file && now - v.startedAt < L.retriggerMs)) return { ok: false, reason: 'retrigger' }
      if (isVoice(req.kind)) {
        // One voice per entity: a new one replaces the previous, except that nothing replaces a death cry.
        const prev = mine.filter(v => isVoice(v.kind))
        if (req.kind !== 'death' && prev.some(v => v.kind === 'death')) return { ok: false, reason: 'voice' }
        for (const v of prev) steal.add(v.id)
      } else {
        const sfx = mine.filter(v => !isVoice(v.kind)).sort((a, b) => a.startedAt - b.startedAt)
        for (let i = 0; i <= sfx.length - L.entitySfx; i++) steal.add(sfx[i]!.id)
      }
    }
    // The same file at most `sameFile` times: the next steals the oldest of them.
    const same = live().filter(v => v.file === req.file && !v.loop).sort((a, b) => a.startedAt - b.startedAt)
    for (let i = 0; i <= same.length - L.sameFile; i++) steal.add(same[i]!.id)
    if (!req.loop) {
      const bus = live().filter(v => v.bus === req.bus && !v.loop)
      const busCap = L.bus[req.bus] - (req.bus === 'ambient' ? 1 : 0)
      if (bus.length >= busCap && !this.stealOne(req, bus, steal)) return { ok: false, reason: 'busy' }
      const all = live().filter(v => !v.loop)
      if (all.length >= L.total && !this.stealOne(req, all, steal)) return { ok: false, reason: 'busy' }
    }
    return { ok: true, steal: [...steal] }
  }

  private stealOne(req: VoiceRequest, pool: ActiveVoice[], steal: Set<number>): boolean {
    const victim = [...pool].sort(stealOrder)[0]
    if (!victim || !outranks(req, victim)) return false
    steal.add(victim.id)
    return true
  }
}

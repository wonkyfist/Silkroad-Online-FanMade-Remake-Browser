/** One row of work/out/index.json. `glb` and `sidecar` are paths relative to /out/. */
export interface IndexEntry {
  id: string
  name: string
  category: string
  glb: string
  sidecar?: string
}

/** Animation event from the sidecar. Known types: 1 = hit, 2 = footstep. */
export interface AnimEvent {
  timeMs: number
  type: number
  [extra: string]: unknown
}

export interface SidecarAnimation {
  name?: string
  clip?: string
  file?: string
  durationMs?: number
  events?: AnimEvent[]
  /** Overlay clip: animates only a few joints (e.g. DAMAGE1) and must play on top of a full clip. */
  partial?: boolean
  [extra: string]: unknown
}

/** Converter sidecar JSON. Only `animations` is interpreted; the rest is shown raw. */
export interface Sidecar {
  animations?: SidecarAnimation[]
  [extra: string]: unknown
}

export function isIndexEntry(v: unknown): v is IndexEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.id === 'string' && typeof e.glb === 'string'
}

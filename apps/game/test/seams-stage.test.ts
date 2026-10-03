/**
 * The character-screen stage seam (docs/SCREENS.md §0B.10 SCR-S, landed by W10-G; docs/WAVE_PLAN6.md §4.2): `app.stage`
 * exists and is built lazily, the stub host refuses with "not built" (the screens keep their fallback scene), and the
 * stage table's entries fit `StageDef` (SCR-R's `stage/stages.ts` once it lands; the §0B.2 values until then).
 */
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.ts'
import { STAGE_NOT_BUILT, createStageHost } from '../src/stage/host.ts'
import type { StageDef } from '../src/stage/types.ts'

/** SCREENS §0B.2: one spot on the Jangan south-gate steps; create turns the camera around (the fallback fixtures). */
const SECTION_0B2: StageDef[] = [
  {
    id: 'select',
    world: 'server',
    spot: { x: 101.0, z: -56.0, yHint: -3.26 },
    facing: Math.PI,
    camera: { kind: 'fixed', distM: 3.94, heightM: 1.35, yaw: 0, fovDeg: 50, targetHeightM: 1.05 },
    time: { kind: 'server', fallback: 0.773 },
    weather: 'server',
    readyRadiusM: 150,
  },
  {
    id: 'create',
    world: 'server',
    spot: { x: 101.0, z: -56.0, yHint: -3.26 },
    facing: 0,
    camera: { kind: 'fixed', distM: 3.6, heightM: 0.9, yaw: Math.PI, fovDeg: 50, targetHeightM: 0.75, truckM: 0.45, zoom: { distM: 1.6, heightM: 1.62, targetHeightM: 1.5, truckM: 0.2 } },
    time: { kind: 'server', fallback: 0.773 },
    weather: 'server',
    readyRadiusM: 150,
    rangeScaleCap: 0.6,
  },
]

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

/** The runtime shape of a StageDef (the fields SCR-R's table must carry; extra fields are allowed). */
function fitsStageDef(d: unknown): string | null {
  const o = d as Record<string, unknown>
  if (!o || typeof o !== 'object') return 'not an object'
  if (o.id !== 'select' && o.id !== 'create') return `id ${String(o.id)}`
  if (typeof o.world !== 'string' || !o.world) return 'world'
  const spot = o.spot as Record<string, unknown> | undefined
  if (!spot || !finite(spot.x) || !finite(spot.z) || !finite(spot.yHint)) return 'spot'
  if (!finite(o.facing)) return 'facing'
  const c = o.camera as Record<string, unknown> | undefined
  if (!c || c.kind !== 'fixed') return 'camera.kind (fixed only this wave)'
  for (const k of ['distM', 'heightM', 'yaw', 'fovDeg', 'targetHeightM']) if (!finite(c[k])) return `camera.${k}`
  if (!((c.distM as number) > 0) || !((c.fovDeg as number) > 0 && (c.fovDeg as number) < 180)) return 'camera range'
  const time = o.time as unknown
  const timeOk = (finite(time) && (time as number) >= 0 && (time as number) <= 1)
    || (typeof time === 'object' && time !== null && (time as { kind?: unknown }).kind === 'server' && finite((time as { fallback?: unknown }).fallback))
  if (!timeOk) return 'time'
  if (o.weather !== 'clear' && o.weather !== 'server') return 'weather'
  if (o.readyRadiusM !== undefined && !((o.readyRadiusM as number) > 0)) return 'readyRadiusM'
  return null
}

describe('app.stage (SCREENS SCR-S)', () => {
  it('exists and is built lazily, once', () => {
    // No DOM here: an App without its constructor (the getter reads only its own field).
    const app = Object.create(App.prototype) as App
    expect((app as unknown as { stageHost?: unknown }).stageHost ?? null).toBeNull()
    const host = app.stage
    expect(typeof host.enter).toBe('function')
    expect(typeof host.release).toBe('function')
    expect((app as unknown as { stageHost?: unknown }).stageHost).toBe(host)
    expect(app.stage).toBe(host)
  })

  it('the stub host refuses to enter with "not built" and releases without throwing', async () => {
    const host = createStageHost(Object.create(App.prototype) as App)
    await expect(host.enter(SECTION_0B2[0]!)).rejects.toThrow('not built')
    await expect(host.enter(SECTION_0B2[1]!, { onProgress: () => {} })).rejects.toThrow(STAGE_NOT_BUILT)
    expect(() => host.release()).not.toThrow()
    expect(() => host.release()).not.toThrow()
  })

  it('the stage table entries fit StageDef (fixed cameras only)', async () => {
    let table: StageDef[] = SECTION_0B2
    try {
      // SCR-R's data file, once it exists (`STAGES.select`, `STAGES.create`).
      const path = '../src/stage/stages.ts'
      const mod = (await import(/* @vite-ignore */ path)) as { STAGES?: Record<string, StageDef> }
      if (mod.STAGES) table = Object.values(mod.STAGES)
    } catch {
      // not landed yet: the §0B.2 values
    }
    expect(table.length).toBeGreaterThan(0)
    for (const def of table) expect(fitsStageDef(def), JSON.stringify(def)).toBeNull()
    expect(fitsStageDef({ ...SECTION_0B2[0], camera: { kind: 'path', keys: [], loop: true } })).toMatch(/camera/)
    expect(fitsStageDef({ ...SECTION_0B2[0], id: 'intro' })).toMatch(/id/)
  })
})

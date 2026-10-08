// The licensed bodies as everyone's standard (docs/CHARACTERS.md §16.8): which body a player gets (its look, its
// default, the debug escape, the fallback when the pack is not served), the LOD choice, the crowd plan carrying it.
import { defaultLook } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { licensedAvailable, licensedChoiceFor, licensedEnabled, resetLicensedCache } from '../src/three/licensed-char.ts'
import { LICENSED_LOD1_FROM_M, LICENSED_LOD2_FROM_M, LICENSED_LOD_HYSTERESIS_M, licensedLodFor } from '../src/world/char-lod.ts'
import { ANIM_FROM, planCrowd, type CrowdEntry } from '../src/world/crowd-budget.ts'

describe('who is drawn on a licensed body', () => {
  it('everyone by default; ?newchar=0 and the pilot presets keep the retail models', () => {
    expect(licensedEnabled('')).toBe(true)
    expect(licensedEnabled('?newchar=1')).toBe(true)
    expect(licensedEnabled('?newchar=0')).toBe(false)
    expect(licensedEnabled('?newchar=average')).toBe(false)
    expect(licensedChoiceFor('?newchar=0', 'female', undefined, 3)).toBeNull()
  })

  it("draws the look's outfit, the body's default without one (older server), never a look of the other body", () => {
    const look = { ...defaultLook('f'), outfit: '03' }
    expect(licensedChoiceFor('', 'female', look, 9)).toEqual({ gender: 'f', outfit: '03' })
    expect(licensedChoiceFor('', 'male', undefined, 4)).toEqual({ gender: 'm', outfit: defaultLook('m', 4).outfit })
    // a girl's look on a boy's model: the boy's default
    expect(licensedChoiceFor('', 'male', look, 4)).toEqual({ gender: 'm', outfit: defaultLook('m', 4).outfit })
    // ncoutfit only for the own character
    expect(licensedChoiceFor('?ncoutfit=02', 'female', look, 9, true)?.outfit).toBe('02')
    expect(licensedChoiceFor('?ncoutfit=02', 'female', look, 9, false)?.outfit).toBe('03')
    expect(licensedChoiceFor('', undefined, look, 1)).toBeNull()
  })

  it('falls back to the retail models when the pack is not served (a GitHub clone): checked once per file', async () => {
    resetLicensedCache()
    let calls = 0
    const notFound = (async () => (calls++, new Response('no', { status: 404 }))) as unknown as typeof fetch
    const c = licensedChoiceFor('', 'female', undefined, 1)!
    expect(await licensedAvailable(c, notFound)).toBe(false)
    expect(await licensedAvailable(c, notFound)).toBe(false)
    expect(calls).toBe(1)
    resetLicensedCache()
    const served = (async () => new Response(JSON.stringify({ retarget: { version: 1 } }))) as unknown as typeof fetch
    expect(await licensedAvailable(c, served)).toBe(true)
    resetLicensedCache()
  })
})

describe('licensed LODs (§16.8)', () => {
  it('LOD0 kept / near, LOD1 then LOD2 by distance (the close set at most LOD1), LOD2 in the crowd tier; a hysteresis', () => {
    expect(licensedLodFor(80, { keep: true })).toBe(0)
    expect(licensedLodFor(40, { close: true })).toBe(1)
    expect(licensedLodFor(LICENSED_LOD1_FROM_M + 1, { close: true })).toBe(1)
    expect(licensedLodFor(LICENSED_LOD1_FROM_M - 1, { close: true })).toBe(0)
    expect(licensedLodFor(5, { crowd: true })).toBe(2)
    expect(licensedLodFor(LICENSED_LOD1_FROM_M - 1, {})).toBe(0)
    expect(licensedLodFor(LICENSED_LOD1_FROM_M + 1, {})).toBe(1)
    expect(licensedLodFor(LICENSED_LOD2_FROM_M + 1, {})).toBe(2)
    // just inside a line: stays at the farther LOD it had
    expect(licensedLodFor(LICENSED_LOD1_FROM_M - LICENSED_LOD_HYSTERESIS_M / 2, {}, 1)).toBe(1)
    expect(licensedLodFor(LICENSED_LOD2_FROM_M - LICENSED_LOD_HYSTERESIS_M / 2, {}, 2)).toBe(2)
    expect(licensedLodFor(LICENSED_LOD2_FROM_M - LICENSED_LOD_HYSTERESIS_M * 2, {}, 2)).toBe(1)
  })

  it('the crowd plan: the close set on LOD0, the crowd on LOD2, a small crowd by distance, kept ones on LOD0', () => {
    const entries: CrowdEntry[] = [{ d: 3, keep: true, wasCasting: true }]
    for (let i = 0; i < ANIM_FROM + 20; i++) entries.push({ d: 4 + i * 1.5, keep: false, wasCasting: false })
    const out = planCrowd(entries, null, true, [], true, true)
    expect(out[0]!.licensedLod).toBe(0)
    for (let i = 1; i < entries.length; i++) expect(out[i]!.licensedLod).toBe(out[i]!.close ? (entries[i]!.d > LICENSED_LOD1_FROM_M ? 1 : 0) : 2)
    expect(out.filter(o => o.close).length).toBeGreaterThan(0)
    // fewer than ANIM_FROM others: no crowd tier, the LOD by distance
    const few: CrowdEntry[] = [5, 20, 45].map(d => ({ d, keep: false, wasCasting: false }))
    expect(planCrowd(few, null, true, [], true, true).map(o => o.licensedLod)).toEqual([0, 1, 2])
    // the animation rules off (Low): by distance too
    expect(planCrowd(few, null, false).map(o => o.licensedLod)).toEqual([0, 1, 2])
  })
})

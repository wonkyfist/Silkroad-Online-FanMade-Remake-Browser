/**
 * Storms on the client (docs/WEATHER.md §12.7): the weather icon's tooltip lines and the chat lines from the server's
 * `storm` status, the night-storm fog, and StormFx on a NullEngine: many charged monsters and arcs over a long storm
 * never make a mesh, material or texture beyond its fixed one each (no leaks: the black-screen bug), stay inside the
 * capacity, and dispose back to the scene's baseline.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { CALM_ENV, STORM_TABLE, stormEffects, type StormStatus } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { stormNightFog } from '../src/world/features/weather.ts'
import { signedPct, stormChatLine, stormIconSvg, stormTipLines } from '../src/world/features/storm.ts'
import { ARC_MS, CAP, MAX_CHARGED, StormFx, type ChargedBody } from '../src/world/storm/fx.ts'

const T0 = Date.UTC(2026, 9, 5, 12)
const NIGHT_STORM = { ...CALM_ENV, rain: 1, storm: 1, windMs: 13, wet: 1, night: 1 }

describe('the weather icon and the forecast lines', () => {
  it('lists every active effect with its signed percent; the forecast and the storm count down', () => {
    const s: StormStatus = { phase: 'storm', endsAt: T0 + 7.5 * 60_000, effects: stormEffects(NIGHT_STORM) }
    const tip = stormTipLines(s, T0)
    expect(tip.title).toBe('Thunderstorm')
    expect(tip.time).toBe('Ends in about 8 min')
    expect(tip.effects).toHaveLength(s.effects.length)
    expect(tip.effects).toContain('Monster sight -55%: sneak past camps')
    expect(tip.effects).toContain('Undead and ghosts: faster, damage +25%')
    expect(tip.effects.every((l) => !l.includes('{'))).toBe(true)
    const fc = stormTipLines({ phase: 'forecast', startsAt: T0 + 4 * 60_000 + 1, effects: [] }, T0)
    expect(fc.title).toBe('A storm is coming (in about 5 min)')
    expect(signedPct(25)).toBe('+25')
    expect(signedPct(-40)).toBe('-40')
    expect(signedPct(undefined)).toBe('')
    expect(stormIconSvg('rain')).toContain('<svg')
  })

  it('says it in chat when a storm is forecast, when it breaks and when it passes; nothing for rain or a repeat', () => {
    const fc: StormStatus = { phase: 'forecast', startsAt: T0 + 5 * 60_000, effects: [] }
    expect(stormChatLine('calm', fc, T0)).toBe('A storm is gathering over the fields... It breaks in about 5 min.')
    expect(stormChatLine('forecast', fc, T0)).toBeNull()
    expect(stormChatLine('forecast', { phase: 'storm', effects: [] }, T0)).toMatch(/^The storm breaks!/)
    expect(stormChatLine(null, { phase: 'storm', effects: [] }, T0)).toMatch(/^The storm breaks!/)
    expect(stormChatLine('storm', { phase: 'rain', effects: [] }, T0)).toBe('The storm passes.')
    expect(stormChatLine('calm', { phase: 'rain', effects: [] }, T0)).toBeNull()
    expect(stormChatLine(null, { phase: 'calm', effects: [] }, T0)).toBeNull()
  })

  it('closes the view in at night in a storm (the server says how dark), not by day', () => {
    expect(stormNightFog({ effects: stormEffects(NIGHT_STORM) })).toBeCloseTo(STORM_TABLE.nightFogAdd, 9)
    expect(stormNightFog({ effects: stormEffects({ ...NIGHT_STORM, night: 0 }) })).toBe(0)
    expect(stormNightFog({ effects: [] })).toBe(0)
  })
})

describe('StormFx on a NullEngine (no leaks, fixed resources)', () => {
  it('many charged monsters and arcs over a long storm: one mesh, one material, one texture; capacity holds; dispose returns to the baseline', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('cam', 0, 1, 30, new Vector3(0, 0, 0), scene)
    scene.activeCamera = camera
    const base = { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }
    const fx = new StormFx(scene)
    const after = { meshes: base.meshes + 1, materials: base.materials + 1, textures: base.textures + 1 }
    expect({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }).toEqual(after)
    const bodies: ChargedBody[] = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, x: i * 2, y: 1, z: -i, r: 0.6 + (i % 3) * 0.4 }))
    let maxQuads = 0
    let frame = 0
    for (let t = T0; t < T0 + 60_000; t += 50) {
      if (frame % 10 === 0) fx.arc([t % 7, 1, 0], [3, 1, (t % 5) - 2], t)
      fx.update(t, bodies.slice(0, 1 + (frame % 40)), camera)
      if (++frame % 9 === 0) scene.render()
      maxQuads = Math.max(maxQuads, fx.stats().quads)
      expect(fx.stats().quads).toBeLessThanOrEqual(CAP)
    }
    expect(maxQuads).toBeGreaterThan(MAX_CHARGED * 4)
    expect({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }).toEqual(after)
    // the arcs die out; with nobody charged nothing is drawn
    fx.update(T0 + 60_000 + ARC_MS + 10, [], camera)
    expect(fx.stats()).toEqual({ arcs: 0, quads: 0 })
    fx.dispose()
    fx.dispose()
    expect({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }).toEqual(base)
    fx.update(T0, bodies, camera) // ignored after dispose
    scene.dispose()
    engine.dispose()
  })
})

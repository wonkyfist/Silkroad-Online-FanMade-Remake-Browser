/** The perf audit's logic changes (docs/PERF_AUDIT.md): the name plates' anchor without a CSS read back. */
import { describe, expect, it } from 'vitest'
import { labelAnchor, setLabelAnchor } from '../src/world/nameplates.ts'
import { PERF } from '../src/world/perf.ts'

describe('labelAnchor (PERF.plateAnchor)', () => {
  it('returns the numbers setLabelAnchor kept, equal to the transform parse', () => {
    const label = { style: { transform: 'translate(120.5px, -33.2px) translate(-50%, -100%)' } }
    setLabelAnchor(label, 120.5, -33.2)
    expect(labelAnchor(label)).toEqual({ x: 120.5, y: -33.2 })
    PERF.plateAnchor = false
    try {
      expect(labelAnchor(label)).toEqual({ x: 120.5, y: -33.2 })
    } finally {
      PERF.plateAnchor = true
    }
  })

  it('follows later moves and parses a label nobody anchored', () => {
    const label = { style: { transform: '' } }
    setLabelAnchor(label, 1, 2)
    setLabelAnchor(label, 3, 4)
    expect(labelAnchor(label)).toEqual({ x: 3, y: 4 })
    expect(labelAnchor({ style: { transform: 'translate(7px, 8px) translate(-50%, -100%)' } })).toEqual({ x: 7, y: 8 })
    expect(labelAnchor({ style: { transform: '' } })).toBeNull()
  })
})

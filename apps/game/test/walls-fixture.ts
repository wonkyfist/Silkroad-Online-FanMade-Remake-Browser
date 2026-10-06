/**
 * A small synthetic wall for the layer-2 tests (docs/SIEGE.md §14 "Client"): one south side along x (the field at
 * +z), three 45 m segments S1..S3 of 15 m thirds, the brick body from z 10 (inner face) to z 30 (outer face), 20 m
 * high, and a gatehouse `S-gate` right after S3. No retail data.
 */
import type { Vec3, WallsExport, WallsSegment, WallsSideInfo } from '@sro/shared'

export const SIDE: WallsSideInfo = {
  side: 'S', axis: 'x', line: 20, outer: 30, inner: 10, out: 1, walkY: 20,
  placement: { region: 1, uid: 2, source: 'test', position: [0, 0, 20] }, retailInstance: 3,
  fixed: [{ id: 'S-gate', from: 135, to: 160, what: 'gatehouse', instances: [] }],
}

export function walls(): WallsExport {
  const segments: WallsSegment[] = [0, 1, 2].map((s) => {
    const from = s * 45
    return {
      id: `S${s + 1}`, side: 'S', from, to: from + 45,
      thirds: [0, 1, 2].map((k) => ({
        id: `S${s + 1}${'abc'[k]}`, from: from + 15 * k, to: from + 15 * (k + 1), instances: [], tiles: [],
        assault: [0, 0, 0] as Vec3, rally: [0, 0, 0] as Vec3,
      })) as WallsSegment['thirds'],
    }
  })
  return { version: 1, world: 'test', plan: { file: 'test', hash: 'test' }, navFile: 'siege/walls-nav.bin', sides: [SIDE], segments }
}

/** Flat ground at 0 m. */
export const flatGround = () => 0

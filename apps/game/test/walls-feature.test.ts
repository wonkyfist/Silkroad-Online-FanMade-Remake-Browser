/**
 * Siege of Jangan, layer 1 on the client (docs/SIEGE.md §4.2, §9, §14 "Client"): the walls feature loads the export's
 * walls.json and nav pieces, switches the retail wall off, and applies the server's stages to the client's nav with
 * the shared rule, so the walker's prediction goes through a gap (and stops at a closed one); messages that arrive
 * before the export are kept; a breach, a collapse and a closing are told in chat.
 */
import { NavGltf, NavWorld, buildNavData, encodeNavData, type NavData, type NavMeshInput, type NavPosition } from '@sro/nav'
import type { ServerMessage, Vec3, WallsExport } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { wallsFeature } from '../src/world/features/walls.ts'
import { flatRegion, grid, mesh, placement } from '../../../packages/nav/test/synthetic.ts'

const RX = 100, RZ = 100, REGION = (RZ << 8) | RX
const pieceId = (k: number) => ((REGION << 16) | (0xf000 | k)) >>> 0
const slab = (x0: number, x1: number): NavMeshInput => {
  const g = grid(x0, x1, -80, 80, 3, 1, () => 200)
  return mesh(g.vertices, g.triangles, () => 3).nav
}
const model = (m: NavMeshInput, key: string) => {
  const e = (x: NavMeshInput['outlineEdges']) => ({ vertices: Uint16Array.from(x.vertices), cells: Uint16Array.from(x.cells), flags: Uint8Array.from(x.flags) })
  return { key, vertices: Float32Array.from(m.vertices), cells: Uint16Array.from(m.cells), outline: e(m.outlineEdges), inline: e(m.inlineEdges), events: [] as string[] }
}

function world(): NavGltf {
  const nvm = { ...flatRegion(), objects: [placement(0, 0x8001, 960, 0, 960)] }
  nvm.objects[0]!.regionId = REGION
  const data = buildNavData({ regions: [{ id: REGION, nvm }], objectNavMesh: () => ({ key: 'wall', navMesh: slab(-450, 450) }) })
  return new NavGltf(new NavWorld(data), { x: RX, z: RZ })
}

function piecesBytes(): Uint8Array {
  const spans: [number, number][] = [[-450, -150], [-150, 150], [150, 450]]
  const pieces: NavData = {
    version: 1, regions: [], models: spans.map(([a, b], k) => model(slab(a, b), `wall#${k}`)),
    instances: spans.map((_, k) => ({ id: pieceId(k), objId: 1, model: k, x: 1920 * RX + 960, y: 0, z: 1920 * RZ + 960, yaw: 0, links: [] })),
  }
  return encodeNavData(pieces)
}

const walls: WallsExport = {
  version: 1, world: 'test', plan: { file: 'content/siege/jangan.json', hash: 'test' }, navFile: 'siege/walls-nav.bin',
  sides: [{ side: 'N', axis: 'x', line: -96, outer: -104, inner: -88, out: -1, walkY: 20, placement: { region: REGION, uid: 0x8001, source: 'wall', position: [96, 0, -96] }, retailInstance: ((REGION << 16) | 0x8001) >>> 0, fixed: [] }],
  segments: [{
    id: 'N1', side: 'N', from: 51, to: 141,
    thirds: [0, 1, 2].map((k) => ({ id: `N1${'abc'[k]}`, from: 51 + 30 * k, to: 81 + 30 * k, instances: [pieceId(k)], tiles: [], assault: [0, 0, 0] as Vec3, rally: [0, 0, 0] as Vec3 })) as WallsExport['segments'][0]['thirds'],
  }],
}

function setup() {
  const nav = world()
  const chat: string[] = []
  const bytes = piecesBytes()
  const ground = {
    world: {
      nav,
      stream: null,
      assets: {
        json: async (rel: string) => {
          if (rel !== 'siege/walls.json') throw new Error('404')
          return walls
        },
        bytesOf: async (rel: string) => {
          if (rel !== walls.navFile) throw new Error('404')
          return bytes
        },
      },
    },
  }
  const ctx = {
    session: {},
    scene: {},
    chat: { add: (_k: string, text: string) => chat.push(text) },
    world: () => ground,
  } as unknown as WorldFeatureContext
  return { nav, chat, f: wallsFeature(ctx) }
}

const at = (nav: NavGltf, x: number, z: number): NavPosition => nav.locate(x, z, 0)!
const through = (nav: NavGltf, x: number) => !nav.moveStraight(at(nav, x, -70), x, -130).blocked
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('wallsFeature (client nav and chat)', () => {
  it('a stage before the export is kept; the gap opens and closes on the client nav as on the server', async () => {
    const { nav, chat, f } = setup()
    expect(through(nav, 96)).toBe(false)
    // the server's list arrives before the export is loaded
    f.onMessage!({ t: 'walls', segs: [{ id: 'N1', stage: 'breached', pct: -10 }] } as ServerMessage)
    f.onFrame!(0, 0.016)
    for (let i = 0; i < 5; i++) await settle()
    // the retail wall is off, the middle piece is down: through the middle, blocked on the sides
    expect(through(nav, 96)).toBe(true)
    expect(through(nav, 60)).toBe(false)
    expect(nav.world.runtimeSwitches.disabled).toBe(2)

    f.onMessage!({ t: 'wallUpdate', id: 'N1', stage: 'rubble', pct: -50, at: 1 } as ServerMessage)
    expect(through(nav, 60)).toBe(true)
    expect(chat.at(-1)).toMatch(/North wall of Jangan \(N1\) has collapsed/)
    f.onMessage!({ t: 'wallUpdate', id: 'N1', stage: 'cracked', pct: 6, at: 2 } as ServerMessage)
    expect(through(nav, 96)).toBe(false)
    expect(through(nav, 60)).toBe(false)
    expect(chat.at(-1)).toMatch(/is closed again/)
    f.onMessage!({ t: 'wallUpdate', id: 'N1', stage: 'breached', pct: -1, at: 3 } as ServerMessage)
    expect(chat.at(-1)).toMatch(/has been breached \(N1\)/)
    // a chip is only dust (no view without the cut models here): no crash
    f.onMessage!({ t: 'wallFx', id: 'N1', kind: 'chip', x: 96, y: 20, z: -96, at: 4 } as ServerMessage)
    f.dispose!()
  })

  it('an export without walls.json leaves the retail wall as it was', async () => {
    const nav = world()
    const ctx = {
      session: {},
      scene: {},
      chat: { add: () => {} },
      world: () => ({ world: { nav, stream: null, assets: { json: async () => { throw new Error('404') }, bytesOf: async () => { throw new Error('404') } } } }),
    } as unknown as WorldFeatureContext
    const f = wallsFeature(ctx)
    f.onMessage!({ t: 'walls', segs: [{ id: 'N1', stage: 'rubble', pct: -50 }] } as ServerMessage)
    f.onFrame!(0, 0.016)
    for (let i = 0; i < 5; i++) await settle()
    expect(through(nav, 96)).toBe(false)
    expect(nav.world.runtimeSwitches.disabled).toBe(0)
    f.dispose!()
  })
})

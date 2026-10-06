/**
 * The winter gameplay layer on the client (docs/WINTER.md §13.7): WinterPlayFx on a NullEngine (fixed resources however
 * many snowballs, splats, telegraphs and frosty bodies; nothing left after dispose), the ice look (a plugin on the shared
 * material that recolours only that actor's meshes, follows merges and material swaps, clears with the view; the yeti's
 * clips exist on her base), the HUD's pure rules (the warmth carried forward, when the bar shows, the warnings, the vignette, the gift
 * lines), the synthesized sounds, the strings, and the feature on a stub world (B throws at the target or ahead, the
 * layer's state, the shop tab, splats on name tags, the yeti's telegraphs, cleanup).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArcRotateCamera, Mesh, NullEngine, PBRMaterial, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core'
import { WINTER_CODES, WINTER_MOBS, type ClientMessage, type ServerMessage, type ShopDef, type WarmthState } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { SYNTH_RATE } from '../src/audio/synth.ts'
import { WINTER_PLAY_SYNTH, giftPcm, roarPcm, splatPcm, throwPcm } from '../src/audio/winter-play.ts'
import { t, type StringKey } from '../src/i18n/index.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { THROW_AHEAD_M, YETI_CLIPS, throwPoint, winterPlayFeature } from '../src/world/features/winter-play.ts'
import { ICE_LOOKS, ICE_PLUGIN, SCAN_FRAMES, iceCode, iceLook, iceLookOf, icePluginFor } from '../src/world/winter/ice-look.ts'
import { CAP, MAX_FLIGHTS, MAX_SPLATS, MAX_TELEGRAPHS, WinterPlayFx } from '../src/world/winter/play-fx.ts'
import { frostOpacity, giftLines, warmthColor, warmthNow, warmthVisible, warningFor } from '../src/world/winter/play-hud.ts'

const T0 = Date.UTC(2026, 11, 20, 12)
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const MOBS_JSON = join(REPO, 'work/out/data/mobs.json')

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0, 1, 20, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const count = () => ({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length })
  return { engine, scene, camera, count, close: () => (scene.dispose(), engine.dispose()) }
}

describe('WinterPlayFx on a NullEngine (fixed resources, no leaks)', () => {
  it('two meshes, two materials, one texture whatever is live; bounded lists; nothing after dispose', () => {
    const s = setup()
    const base = s.count()
    const fx = new WinterPlayFx(s.scene)
    expect(s.count()).toEqual({ meshes: base.meshes + 2, materials: base.materials + 2, textures: base.textures + 1 })
    for (let i = 1; i <= 200; i++) {
      fx.addFlight({ id: i, from: [0, 1.6, 0], to: [10, 1, i % 7], at: T0 + i * 10, ms: 700, peakM: 1.5, big: i % 5 === 0 })
      if (i % 2) fx.addSplat(i, [10, 1, 0], T0 + i * 10 + 700)
      if (i % 9 === 0) fx.addTelegraph({ id: 9, skill: (['slam', 'breath', 'barrage', 'roar'] as const)[i % 4]!, pos: [0, 0, 0], yaw: 0, radiusM: 8, angleDeg: 70, start: T0 + i * 10, at: T0 + i * 10 + 900 })
    }
    const bodies = Array.from({ length: 30 }, (_, i) => ({ id: i, x: i, y: 0, z: 0, r: 1, h: 2, big: i === 0, yaw: 0.5, scale: 3.3, head: i === 0 ? ([0, 4, 0] as [number, number, number]) : null }))
    const fires = Array.from({ length: 20 }, (_, i): [number, number, number] => [i * 3, 0, 5])
    for (let now = T0; now < T0 + 4000; now += 33) {
      fx.update(now, s.camera, bodies, fires, (_x, _z, y) => y)
      const st = fx.stats()
      expect(st.flights).toBeLessThanOrEqual(MAX_FLIGHTS)
      expect(st.splats).toBeLessThanOrEqual(MAX_SPLATS)
      expect(st.telegraphs).toBeLessThanOrEqual(MAX_TELEGRAPHS)
      expect(st.quads).toBeLessThanOrEqual(2 * CAP)
    }
    expect(s.count()).toEqual({ meshes: base.meshes + 2, materials: base.materials + 2, textures: base.textures + 1 })
    // everything ends: the flights land, the splats fade, the telegraphs burst and go
    fx.update(T0 + 60_000, s.camera, [], [], (_x, _z, y) => y)
    expect(fx.stats()).toEqual({ flights: 0, splats: 0, telegraphs: 0, quads: 0 })
    fx.dispose()
    fx.dispose()
    expect(s.count()).toEqual(base)
    s.close()
  })
})

describe('the ice look', () => {
  /** A uniform buffer that records the last value per name. */
  const fakeUbo = () => {
    const v = new Map<string, number[]>()
    return { v, ubo: { updateFloat4: (n: string, ...xs: number[]) => v.set(n, xs) } }
  }

  it('tags that actor\'s meshes only, on the shared material (one plugin, no clone), follows merges and swaps, untags with the view', () => {
    const s = setup()
    const shared = new PBRMaterial('ghost', s.scene)
    const other = new Mesh('other-ghost', s.scene)
    other.material = shared
    const m1 = new Mesh('spirit-body', s.scene)
    m1.material = shared
    const std = new Mesh('std', s.scene)
    std.material = new StandardMaterial('std', s.scene)
    const actor = { meshes: [m1, std], allMeshes: () => actor.meshes }
    const view = { state: { kind: 'mob', model: WINTER_CODES.spirit, id: 5 }, actor }
    const materials = s.scene.materials.length
    const textures = s.scene.textures.length
    const a = iceLook(view as never)!
    expect(iceLook({ state: { kind: 'mob', model: 'MOB_CH_WATERGHOST', id: 6 } } as never)).toBeNull()
    a.loaded!()
    expect(iceLookOf(m1)).toBe(ICE_LOOKS[WINTER_CODES.spirit])
    expect(iceLookOf(other)).toBeUndefined()
    expect(iceLookOf(std)).toBeUndefined()
    expect(m1.material).toBe(shared)
    expect(shared.pluginManager?.getPlugin(ICE_PLUGIN)).toBe(icePluginFor(shared))
    expect(icePluginFor(std.material)).toBeNull()
    // per draw: the tagged mesh binds its look, any other mesh of the material amount 0
    const plugin = icePluginFor(shared)!
    const t1 = fakeUbo()
    plugin.hardBindForSubMesh(t1.ubo as never, s.scene, s.engine, { getMesh: () => m1 } as never)
    expect(t1.v.get('sroIceA')![0]).toBe(1)
    expect(t1.v.get('sroIceB')!.slice(0, 3)).toEqual([...ICE_LOOKS[WINTER_CODES.spirit]!.light])
    const t2 = fakeUbo()
    plugin.hardBindForSubMesh(t2.ubo as never, s.scene, s.engine, { getMesh: () => other } as never)
    expect(t2.v.get('sroIceA')![0]).toBe(0)
    // a merge made a new mesh, and the remastered set swapped m1's material: both are picked up by the next scan
    const merged = new Mesh('merged', s.scene)
    merged.material = shared
    const remastered = new PBRMaterial('ghost (remaster)', s.scene)
    m1.material = remastered
    actor.meshes = [m1, merged]
    for (let i = 0; i < SCAN_FRAMES; i++) a.update!(T0, 0.016)
    expect(iceLookOf(merged)).toBe(ICE_LOOKS[WINTER_CODES.spirit])
    expect(remastered.pluginManager?.getPlugin(ICE_PLUGIN)).toBeTruthy()
    // nothing made but the two materials of this test: no texture, no material clone
    expect(s.scene.materials.length).toBe(materials + 1)
    expect(s.scene.textures.length).toBe(textures)
    a.dispose()
    expect(iceLookOf(m1)).toBeUndefined()
    expect(iceLookOf(merged)).toBeUndefined()
    s.close()
  })

  it('every winter monster has a look; the shader code for both languages', () => {
    for (const code of [WINTER_CODES.sprite, WINTER_CODES.spirit, WINTER_CODES.yeti]) expect(ICE_LOOKS[code]).toBeDefined()
    expect(ICE_LOOKS[WINTER_CODES.yeti]!.fur).toBeGreaterThan(0)
    for (const lang of ['glsl', 'wgsl'] as const) {
      const c = iceCode(lang)
      expect(Object.keys(c).sort()).toEqual(['CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION', 'CUSTOM_FRAGMENT_UPDATE_ALPHA'])
      expect(c.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain('surfaceAlbedo')
      expect(c.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain('finalEmissive')
      expect(Object.values(c).join('').includes('uniforms.')).toBe(lang === 'wgsl')
    }
  })

  it.skipIf(!existsSync(MOBS_JSON))('the yeti\'s clips are clips her base model has (work/out)', () => {
    const mobs = JSON.parse(readFileSync(MOBS_JSON, 'utf8')) as { entries: { code: string; model?: { sidecar?: string } }[] }
    const base = WINTER_MOBS.find((m) => m.code === WINTER_CODES.yeti)!.base
    const sidecar = mobs.entries.find((e) => e.code === base)?.model?.sidecar
    expect(sidecar).toBeTruthy()
    const clips = (JSON.parse(readFileSync(join(REPO, 'work', sidecar!), 'utf8')) as { animations: { name: string }[] }).animations.map((a) => a.name)
    for (const clip of Object.values(YETI_CLIPS)) expect(clips).toContain(clip)
  })
})

describe('the HUD rules', () => {
  const W: WarmthState = { value: 80, max: 100, rate: -0.1, level: 'warm', at: T0 }

  it('carries the warmth at its rate, clamped; the bar shows only while on and below full or falling', () => {
    expect(warmthNow(W, T0 + 10_000)).toBeCloseTo(79)
    expect(warmthNow({ ...W, rate: 5 }, T0 + 60_000)).toBe(100)
    expect(warmthNow({ ...W, value: 1 }, T0 + 60_000)).toBe(0)
    expect(warmthVisible(true, W, T0)).toBe(true)
    expect(warmthVisible(false, W, T0)).toBe(false)
    expect(warmthVisible(true, null, T0)).toBe(false)
    expect(warmthVisible(true, { ...W, value: 100, rate: 0 }, T0)).toBe(false)
    expect(warmthVisible(true, { ...W, value: 100, rate: -0.1 }, T0)).toBe(true)
  })

  it('warns on the way down, relieves on the way back; the vignette thickens; never in a town', () => {
    expect(warningFor(null, 'cold')).toBeNull()
    expect(warningFor('warm', 'chilly')).toBe('winterPlay.warn.chilly')
    expect(warningFor('chilly', 'freezing')).toBe('winterPlay.warn.freezing')
    expect(warningFor('cold', 'chilly')).toBeNull()
    expect(warningFor('cold', 'warm')).toBe('winterPlay.warn.warm')
    expect(frostOpacity('freezing')).toBeGreaterThan(frostOpacity('cold'))
    expect(frostOpacity('freezing', true)).toBe(0)
    expect(warmthColor(0)).toBe('rgb(80, 150, 255)')
    expect(warmthColor(1)).toBe('rgb(235, 160, 70)')
  })

  it('the gift lines name the rewards with their counts and the gold', () => {
    expect(giftLines([{ code: 'A', count: 3 }, { code: 'B', count: 1 }], 1500, { name: (c) => `Item ${c}` })).toEqual(['Item A x3', 'Item B', '1,500 gold'])
  })

  it('every string the layer uses exists', () => {
    const keys = [
      'winterPlay.on', 'winterPlay.off', 'winterPlay.warmth.label', 'winterPlay.warmth.tip', 'winterPlay.snowball.key', 'winterPlay.snowball.noSnow', 'winterPlay.snowball.off',
      'winterPlay.splat', 'winterPlay.score', 'winterPlay.board.title', 'winterPlay.board.empty', 'winterPlay.board.me', 'winterPlay.board.rank', 'winterPlay.board.close',
      'winterPlay.gift.title', 'winterPlay.gift.rare', 'winterPlay.gift.gold', 'winterPlay.drained',
      ...(['warm', 'chilly', 'cold', 'freezing'] as const).flatMap((l) => [`winterPlay.level.${l}`, `winterPlay.warn.${l}`]),
      ...(['fire', 'town', 'tea'] as const).map((s) => `winterPlay.source.${s}`),
    ]
    for (const k of keys) expect(t(k as StringKey)).not.toBe(k)
  })
})

describe('the winter sounds (synthesized, deterministic)', () => {
  it('render the set at the synth rate, peaking below clipping, the same every time', () => {
    for (const [id, make] of Object.entries(WINTER_PLAY_SYNTH)) {
      const pcm = make()
      expect(pcm.rate, id).toBe(SYNTH_RATE)
      let peak = 0
      for (const v of pcm.samples) peak = Math.max(peak, Math.abs(v))
      expect(peak, id).toBeGreaterThan(0.3)
      expect(peak, id).toBeLessThanOrEqual(0.95)
    }
    expect(throwPcm().samples.length).toBe(Math.floor(SYNTH_RATE * 0.28))
    expect(roarPcm().samples.length).toBeGreaterThan(splatPcm().samples.length)
    expect(giftPcm(5).samples).toEqual(giftPcm(5).samples)
  })
})

describe('the winter-play feature on a stub world', () => {
  function harness() {
    const s = setup()
    const sent: ClientMessage[] = []
    const chat: string[] = []
    const toasts: string[] = []
    const keys: { id: string; run: (ev: KeyboardEvent) => void }[] = []
    const lines = new Map<number, Map<string, string | null>>()
    const attachments: unknown[] = []
    let now = T0
    let target: unknown = null
    const mkView = (id: number, kind: string, x: number, model = 'CHAR_CH_MAN_ADVENTURER') => {
      const root = new TransformNode(`v${id}`, s.scene)
      root.position.set(x, 0, 0)
      lines.set(id, new Map())
      return {
        id,
        root,
        yaw: 0,
        dead: false,
        height: 2,
        actor: null,
        state: { kind, id, model, name: `N${id}` },
        face: () => {},
        attack: () => [],
        hurt: () => {},
        setLabelLine: (k: string, v: string | null) => lines.get(id)!.set(k, v),
      }
    }
    const me = mkView(1, 'player', 0)
    const friend = mkView(2, 'player', 6)
    const yeti = mkView(3, 'mob', 15, WINTER_CODES.yeti)
    const views = new Map<number, ReturnType<typeof mkView>>([[1, me], [2, friend], [3, yeti]])
    const shops = new Map<string, ShopDef>([[WINTER_CODES.shop, { id: WINTER_CODES.shop, npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potion', items: [] }], provenance: 'client' }]])
    const ctx = {
      session: {},
      scene: s.scene,
      camera: s.camera,
      app: { catalog: { content: { shops } } },
      hud: {
        layer: null,
        toast: (text: string) => void toasts.push(text),
        claimRequests: () => {},
        items: { name: (c: string) => c, icon: () => null },
      },
      keys: {
        register: (b: { id: string; run: (ev: KeyboardEvent) => void }) => {
          keys.push(b)
          return () => keys.splice(keys.indexOf(b), 1)
        },
      },
      chat: { add: (_k: string, text: string) => void chat.push(text) },
      send: (m: ClientMessage) => (sent.push(m), true),
      selfId: () => 1,
      view: (id: number) => views.get(id),
      views: () => views.values(),
      target: () => target,
      serverNow: () => now,
      world: () => null,
      minimap: () => null,
      addAttachment: (f: unknown) => {
        attachments.push(f)
        return () => attachments.splice(attachments.indexOf(f), 1)
      },
    } as unknown as WorldFeatureContext
    const f = winterPlayFeature(ctx)
    const msg = (m: unknown) => f.onMessage!(m as ServerMessage)
    const press = (shift = false) => keys.find((k) => k.id === 'winter.snowball')!.run({ shiftKey: shift } as KeyboardEvent)
    return { s, f, msg, press, sent, chat, toasts, keys, lines, attachments, shops, me, friend, yeti, setNow: (v: number) => (now = v), setTarget: (v: unknown) => (target = v) }
  }

  it('the layer: a chat line, the shop tab, B throws at the target or ahead, Shift+B asks for the board; cleanup', () => {
    const h = harness()
    const base = h.s.count()
    expect(h.attachments).toHaveLength(1)
    // off: B tells why and sends nothing
    h.press()
    expect(h.sent).toHaveLength(0)
    expect(h.toasts.at(-1)).toBe(t('winterPlay.snowball.off'))
    h.msg({ t: 'winterPlay', play: { on: true, snowballs: true, fires: [[2, 0, 2]], season: '2026-27' } })
    expect(h.chat.at(-1)).toBe(t('winterPlay.on'))
    expect(h.shops.get(WINTER_CODES.shop)!.tabs.map((x) => x.name)).toEqual(['Potion', 'Winter'])
    h.setTarget(h.friend)
    h.press()
    expect(h.sent.at(-1)).toEqual({ t: 'snowball', target: 2 })
    h.setTarget(null)
    h.press()
    const p = throwPoint(0, 0, 0)
    expect(h.sent.at(-1)).toEqual({ t: 'snowball', x: p.x, z: p.z })
    expect(p.z).toBe(THROW_AHEAD_M)
    h.press(true)
    expect(h.sent.at(-1)).toEqual({ t: 'winterBoard' })
    // a flight, a splat on the friend: "Splat!" on the name tag, cleared after a while; the score toast for the thrower
    h.msg({ t: 'snowball', id: 1, from: 1, fromPos: [0, 1.6, 0], to: [6, 1, 0], at: T0, ms: 600, peakM: 1.3, target: 2 })
    h.f.onFrame!(T0 + 300, 0.016)
    h.msg({ t: 'snowballSplat', id: 1, pos: [6, 1, 0], hit: 2, slowMs: 1500, score: 4 })
    expect(h.lines.get(2)!.get('winter-splat')).toBe(t('winterPlay.splat'))
    expect(h.toasts.at(-1)).toBe(t('winterPlay.score', { n: 4 }))
    h.setNow(T0 + 5000)
    h.f.onFrame!(T0 + 5000, 0.016)
    expect(h.lines.get(2)!.get('winter-splat')).toBeNull()
    // the yeti winds up: the FX draws its telegraph (2 meshes, 2 materials, 1 texture in all)
    h.msg({ t: 'yetiSkill', id: 3, skill: 'slam', at: T0 + 6000, castMs: 1100, pos: [15, 0, 0], yaw: 0, radiusM: 6 })
    h.f.onFrame!(T0 + 5500, 0.016)
    expect(h.s.count()).toEqual({ meshes: base.meshes + 2, materials: base.materials + 2, textures: base.textures + 1 })
    // warmth warnings on the way down and back
    h.msg({ t: 'warmth', warmth: { value: 60, max: 100, rate: -0.1, level: 'warm', at: T0 } })
    h.msg({ t: 'warmth', warmth: { value: 45, max: 100, rate: -0.1, level: 'chilly', at: T0 } })
    expect(h.chat.at(-1)).toBe(t('winterPlay.warn.chilly'))
    h.msg({ t: 'warmth', warmth: { value: 0, max: 100, rate: 0, level: 'freezing', at: T0, drained: 2 } })
    expect(h.chat.slice(-2)).toEqual([t('winterPlay.warn.freezing'), t('winterPlay.drained', { hp: 2 })])
    h.msg({ t: 'warmth', warmth: { value: 60, max: 100, rate: 3, level: 'warm', at: T0, source: 'fire' } })
    expect(h.chat.at(-1)).toBe(t('winterPlay.warn.warm'))
    // off again: the tab goes; dispose frees everything
    h.msg({ t: 'winterPlay', play: { on: false, snowballs: false } })
    expect(h.chat.at(-1)).toBe(t('winterPlay.off'))
    expect(h.shops.get(WINTER_CODES.shop)!.tabs.map((x) => x.name)).toEqual(['Potion'])
    h.f.dispose!()
    expect(h.keys).toHaveLength(0)
    expect(h.attachments).toHaveLength(0)
    expect(h.s.count()).toEqual(base)
    h.s.close()
  })
})

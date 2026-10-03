/**
 * Lane UX-B (docs/UX_GAPS.md §8 UX-B): level bands, name-tag layout, auto looting, hold-to-move / blocked-path
 * feedback, chat parsing and history, minimap coordinates. DOM-free: only the pure parts are exercised.
 */
import { parseClientMessage, type ClientMessage, type MoveState, type ServerMessage } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { AutoLoot, LOOT_PER_PRESS, LOOT_TIMEOUT_MS, nearestFreeItem, type LootCandidate } from '../src/world/autoloot.ts'
import { behindAlpha } from '../src/world/camera-keys.ts'
import { ChatHistory, chatCategory, chatLineFor, matchPrefix, parseWhisper } from '../src/world/chat.ts'
import { sroCoords } from '../src/world/jangan/minimap.ts'
import { levelBand } from '../src/world/level-band.ts'
import { MoveFeedback, noteGroundMove, onGroundMove, type GroundPoint } from '../src/world/move-feedback.ts'
import { ITEM_LABEL_CAP, MOB_LABEL_CAP, NUDGE_PX, labelAnchor, layoutPlates, platePriority, type PlateInput } from '../src/world/nameplates.ts'

describe('levelBand boundaries (UX_GAPS §4.2)', () => {
  it('maps the level difference to the five bands', () => {
    const at = (d: number) => levelBand(10 + d, 10)
    expect([-7, -6, -5, -3, -2, 0, 2, 3, 5, 6, 9].map(at)).toEqual([
      'weak2', 'weak2', 'weak1', 'weak1', 'normal', 'normal', 'normal', 'strong1', 'strong1', 'strong2', 'strong2',
    ])
  })
})

describe('name-tag layout (F1)', () => {
  const plate = (id: number, x: number, y: number, extra: Partial<PlateInput> = {}): PlateInput => ({
    id, x, y, w: 80, h: 14, kind: 'mob', prio: platePriority({ hovered: false, target: false, self: false, kind: 'mob', attackingMe: false, dist: id }), ...extra,
  })
  const byId = (out: ReturnType<typeof layoutPlates>) => new Map(out.map(o => [o.id, o]))

  it('keeps separate labels in place and nudges overlapping ones up, then hides them', () => {
    const out = byId(layoutPlates([plate(1, 0, 100), plate(2, 300, 100), plate(3, 10, 100), plate(4, 5, 100), plate(5, 0, 100), plate(6, 0, 100), plate(7, 0, 100)]))
    expect(out.get(1)).toEqual({ id: 1, dy: 0, visible: true })
    expect(out.get(2)).toEqual({ id: 2, dy: 0, visible: true })
    expect(out.get(3)?.dy).toBe(NUDGE_PX)
    expect(out.get(4)?.dy).toBe(2 * NUDGE_PX)
    expect(out.get(5)?.dy).toBe(3 * NUDGE_PX)
    expect(out.get(6)?.visible).toBe(false)
    expect(out.get(7)?.visible).toBe(false)
  })

  it('never hides a hovered or targeted label, and places it first', () => {
    const crowd = Array.from({ length: 6 }, (_, i) => plate(i + 1, 0, 100))
    const hovered = plate(50, 0, 100, { pinned: true, prio: platePriority({ hovered: true, target: false, self: false, kind: 'mob', attackingMe: false, dist: 99 }) })
    const target = plate(60, 0, 100, { pinned: true, prio: platePriority({ hovered: false, target: true, self: false, kind: 'mob', attackingMe: false, dist: 99 }) })
    const out = byId(layoutPlates([...crowd, hovered, target]))
    expect(out.get(50)).toEqual({ id: 50, dy: 0, visible: true })
    expect(out.get(60)?.visible).toBe(true)
    expect(out.get(60)?.dy).toBe(NUDGE_PX)
  })

  it('orders players over NPCs over mobs attacking me over other mobs over items; nearer first', () => {
    const p = (kind: PlateInput['kind'], attackingMe = false, dist = 10) => platePriority({ hovered: false, target: false, self: false, kind, attackingMe, dist })
    expect(p('player')).toBeGreaterThan(p('npc'))
    expect(p('npc')).toBeGreaterThan(p('mob', true))
    expect(p('mob', true, 50)).toBeGreaterThan(p('mob', false, 1))
    expect(p('mob', false, 1)).toBeGreaterThan(p('mob', false, 20))
    expect(p('mob', false, 900)).toBeGreaterThan(p('item', false, 0))
  })

  it('reads the anchor EntityView.updateLabel placed a label at', () => {
    expect(labelAnchor({ style: { transform: 'translate(412.5px, -3.2px) translate(-50%, -100%)' } })).toEqual({ x: 412.5, y: -3.2 })
    expect(labelAnchor({ style: { transform: '' } })).toBeNull()
  })

  it('caps visible mob and item labels', () => {
    const mobs = Array.from({ length: 40 }, (_, i) => plate(i + 1, i * 100, 100))
    const items = Array.from({ length: 20 }, (_, i) => plate(100 + i, i * 100, 400, { kind: 'item', prio: 100 }))
    const out = layoutPlates([...mobs, ...items])
    expect(out.filter(o => o.visible && o.id < 100).length).toBe(MOB_LABEL_CAP)
    expect(out.filter(o => o.visible && o.id >= 100).length).toBe(ITEM_LABEL_CAP)
  })
})

class FakeItem implements LootCandidate {
  readonly kind = 'item'
  isDisposed = false
  constructor(readonly id: number, readonly pos: { x: number; z: number }, readonly state: { model: string }, private readonly freeAt = 0) {}
  itemFree(now: number): boolean {
    return now >= this.freeAt
  }
}

describe('auto looting (K3)', () => {
  const herb = (id: number, x: number, freeAt = 0) => new FakeItem(id, { x, z: 0 }, { model: 'ITEM_ETC_HP_POTION_01' }, freeAt)
  const gold = (id: number, x: number) => new FakeItem(id, { x, z: 0 }, { model: 'ITEM_ETC_GOLD_01' })

  it('nearestFreeItem prefers gold, skips owned items until ownerUntil, respects the radius', () => {
    const items = [herb(1, 2), gold(2, 10), herb(3, 1, 5000), herb(4, 30)]
    expect(nearestFreeItem(items, { x: 0, z: 0 }, 0)?.id).toBe(2)
    expect(nearestFreeItem(items.filter(i => i.id !== 2), { x: 0, z: 0 }, 0)?.id).toBe(1)
    expect(nearestFreeItem(items.filter(i => i.id !== 2), { x: 0, z: 0 }, 6000)?.id).toBe(3)
    expect(nearestFreeItem([herb(4, 30)], { x: 0, z: 0 }, 0)).toBeNull()
  })

  function setup(items: FakeItem[]) {
    const sent: ClientMessage[] = []
    const loot = new AutoLoot<FakeItem>({
      send: m => {
        expect(parseClientMessage(JSON.stringify(m)).ok).toBe(true)
        sent.push(m)
        return true
      },
      views: () => items.filter(i => !i.isDisposed),
      self: () => ({ x: 0, z: 0 }),
    })
    const pick = (id: number) => {
      const it = items.find(i => i.id === id)!
      it.isDisposed = true
      loot.onDespawn(id, 0)
    }
    return { sent, loot, pick }
  }

  it('actionResult ok does not advance; the despawn does; a failed result stops it', () => {
    const { sent, loot, pick } = setup([herb(1, 3), gold(2, 8), herb(3, 5)])
    loot.press(0)
    expect(sent).toEqual([{ t: 'pickup', id: 2 }])
    expect(loot.onPickupResult(true)).toBe(true)
    expect(sent.length).toBe(1)
    pick(2)
    expect(sent.at(-1)).toEqual({ t: 'pickup', id: 1 })
    expect(loot.onPickupResult(false)).toBe(true)
    expect(loot.active).toBe(false)
    // A repeat while G is still held does not restart after a refusal; a new press does.
    loot.press(10)
    expect(sent.length).toBe(2)
    loot.release()
    loot.press(20)
    expect(loot.active).toBe(true)
    // Results of pickups that were not ours are left to the world screen.
    loot.onPickupResult(true)
    expect(loot.onPickupResult(true)).toBe(false)
  })

  it('gives up on an item after the timeout, and stops after 8 items per press unless held', () => {
    const items = Array.from({ length: 12 }, (_, i) => herb(i + 1, i + 1))
    const { sent, loot, pick } = setup(items)
    loot.press(0)
    loot.release()
    expect(sent.at(-1)).toEqual({ t: 'pickup', id: 1 })
    loot.tick(LOOT_TIMEOUT_MS + 1)
    expect(sent.at(-1)).toEqual({ t: 'pickup', id: 2 })
    for (let i = 2; i <= 12 && loot.active; i++) pick(i)
    expect(loot.active).toBe(false)
    // item 1 skipped (timeout), then 8 picked: 2..9
    expect(sent.map(m => (m as { id: number }).id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(LOOT_PER_PRESS).toBe(8)
  })

  it('keeps going past 8 while G is held', () => {
    const items = Array.from({ length: 12 }, (_, i) => herb(i + 1, i + 1))
    const { sent, loot, pick } = setup(items)
    loot.press(0)
    for (let i = 1; i <= 12; i++) pick(i)
    expect(sent.length).toBe(12)
    expect(loot.active).toBe(false)
  })
})

describe('hold to move and blocked paths (K4, K5)', () => {
  function setup(self: GroundPoint = { x: 0, z: 0 }) {
    const sent: ClientMessage[] = []
    const blocked: { want: GroundPoint; stop: GroundPoint; message: boolean }[] = []
    let cursor: GroundPoint | null = { x: 10, z: 0 }
    const fb = new MoveFeedback({
      send: m => (sent.push(m), true),
      self: () => self,
      cursorGround: () => cursor,
      holdToMove: () => true,
      rtt: () => 50,
      blocked: (want, stop, message) => blocked.push({ want, stop, message }),
    })
    return { sent, blocked, fb, setCursor: (p: GroundPoint | null) => (cursor = p) }
  }
  const moveTo = (x: number, z: number): MoveState => ({ from: [0, 0, 0], to: [x, 0, z], start: 0, speed: 5.5 })

  it('re-sends moveTo toward the cursor every 250 ms while held and it moved > 1 m', () => {
    const { sent, fb, setCursor } = setup()
    fb.begin({ x: 10, z: 0 }, 0)
    fb.tick(100)
    expect(sent).toEqual([])
    setCursor({ x: 10.5, z: 0 })
    fb.tick(300)
    expect(sent).toEqual([])
    setCursor({ x: 14, z: 3 })
    fb.tick(300)
    expect(sent).toEqual([{ t: 'moveTo', x: 14, z: 3 }])
    fb.tick(400)
    expect(sent.length).toBe(1)
    fb.end()
    setCursor({ x: 30, z: 3 })
    fb.tick(2000)
    expect(sent.length).toBe(1)
  })

  it('a clipped walk or no walk at all is reported, the message at most once per 2 s', () => {
    const { blocked, fb } = setup()
    fb.begin({ x: 20, z: 0 }, 0)
    fb.end()
    fb.onSelfMove(moveTo(19.2, 0), 60)
    expect(blocked).toEqual([])
    fb.begin({ x: 20, z: 0 }, 100)
    fb.end()
    fb.onSelfMove(moveTo(8, 0), 160)
    expect(blocked).toEqual([{ want: { x: 20, z: 0 }, stop: { x: 8, z: 0 }, message: true }])
    fb.begin({ x: 0, z: 30 }, 500)
    fb.end()
    fb.tick(700)
    expect(blocked.length).toBe(1)
    fb.tick(1100)
    expect(blocked[1]).toEqual({ want: { x: 0, z: 30 }, stop: { x: 0, z: 0 }, message: false })
    fb.begin({ x: 0, z: 30 }, 2500)
    fb.end()
    fb.tick(3200)
    expect(blocked[2]?.message).toBe(true)
  })

  it('a click where we stand needs no walk; the ground-move bus reaches listeners', () => {
    const { blocked, fb } = setup({ x: 5, z: 5 })
    fb.begin({ x: 5.5, z: 5 }, 0)
    fb.tick(5000)
    expect(blocked).toEqual([])
    const got: GroundPoint[] = []
    const off = onGroundMove(p => got.push(p))
    noteGroundMove({ x: 1, z: 2 })
    off()
    noteGroundMove({ x: 3, z: 4 })
    expect(got).toEqual([{ x: 1, z: 2 }])
  })
})

describe('chat (C1, C2, C7, decision 30)', () => {
  it('parses /w name text; bad names and missing text are local errors', () => {
    expect(parseWhisper('Name hi')).toEqual({ ok: true, to: 'Name', text: 'hi' })
    expect(parseWhisper('Xiao_Lin  hello  there ')).toEqual({ ok: true, to: 'Xiao_Lin', text: 'hello  there' })
    expect(parseWhisper('ab hi')).toEqual({ ok: false, error: 'bad_name' })
    expect(parseWhisper('1abc hi')).toEqual({ ok: false, error: 'bad_name' })
    expect(parseWhisper('Name')).toEqual({ ok: false, error: 'usage' })
    expect(parseWhisper('')).toEqual({ ok: false, error: 'usage' })
  })

  it('matches registered prefixes before the GM path; other slash lines are left alone', () => {
    const prefixes = ['/w', '/whisper', '/r', '/re', '/reply', '#']
    expect(matchPrefix(prefixes, '/w Name hi')).toEqual({ prefix: '/w', rest: 'Name hi' })
    expect(matchPrefix(prefixes, '/W Name hi')).toEqual({ prefix: '/w', rest: 'Name hi' })
    expect(matchPrefix(prefixes, '/whisper Name hi')).toEqual({ prefix: '/whisper', rest: 'Name hi' })
    expect(matchPrefix(prefixes, '/r yo')).toEqual({ prefix: '/r', rest: 'yo' })
    expect(matchPrefix(prefixes, '/R yo')).toEqual({ prefix: '/r', rest: 'yo' })
    expect(matchPrefix(prefixes, '/reply yo')).toEqual({ prefix: '/reply', rest: 'yo' })
    expect(matchPrefix(prefixes, '/r')).toEqual({ prefix: '/r', rest: '' })
    expect(matchPrefix(prefixes, '#all of us')).toEqual({ prefix: '#', rest: 'all of us' })
    // GM commands and plain chat fall through.
    for (const line of ['/who', '/where', '/respawn', '/recall', '/tp 1 2', 'hello /w x', '/wx']) expect(matchPrefix(prefixes, line), line).toBeNull()
  })

  it('whisper frames built from a parsed line pass the validator', () => {
    const w = parseWhisper('MeiHua see you')
    if (!w.ok) throw new Error('parse')
    const msg = { t: 'chat', text: w.text, to: w.to }
    expect(parseClientMessage(JSON.stringify(msg)).ok).toBe(true)
  })

  it('history: Up/Down cycle the last 30 lines, keeping the draft', () => {
    const h = new ChatHistory()
    for (let i = 1; i <= 35; i++) h.push(`line ${i}`)
    expect(h.length).toBe(30)
    expect(h.up('draft')).toBe('line 35')
    expect(h.up('')).toBe('line 34')
    expect(h.down()).toBe('line 35')
    expect(h.down()).toBe('draft')
    for (let i = 0; i < 40; i++) h.up('')
    expect(h.up('')).toBe('line 6')
    h.push('line 35')
    h.push('line 35')
    expect(h.length).toBe(30)
  })

  it('shows whispers as To/From in their own category; local lines as before', () => {
    const names = (id: number) => (id === 7 ? 'Mei' : undefined)
    const msg = (m: Omit<Extract<ServerMessage, { t: 'chat' }>, 't'>) => ({ t: 'chat', ...m }) as Extract<ServerMessage, { t: 'chat' }>
    const inbound = chatLineFor(msg({ channel: 'whisper', fromId: 7, from: 'Mei', to: 'Me', text: 'hi' }), 1, names)
    expect(inbound).toMatchObject({ kind: 'whisper-in', label: 'From Mei: ', name: 'Mei', text: 'hi' })
    const outbound = chatLineFor(msg({ channel: 'whisper', fromId: 1, from: 'Me', to: 'Mei', text: 'yo' }), 1, names)
    expect(outbound).toMatchObject({ kind: 'whisper-out', label: 'To Mei: ', name: 'Mei' })
    expect(chatLineFor(msg({ channel: 'local', fromId: 7, text: 'x' }), 1, names)).toMatchObject({ kind: 'local', label: 'Mei: ' })
    expect(chatLineFor(msg({ channel: 'local', fromId: 1, from: 'Me', text: 'x' }), 1, names)).toMatchObject({ kind: 'self', name: undefined })
    expect(chatLineFor(msg({ channel: 'system', text: 'Server restart' }), 1, names)).toEqual({ kind: 'system', text: 'Server restart' })
    expect(chatCategory('whisper-in')).toBe('whisper')
    expect(chatCategory('gm')).toBe('system')
    expect(chatCategory('self')).toBe('chat')
  })
})

describe('minimap and camera', () => {
  it('SRO coordinates: the Jangan spawn (97, -137) reads (6433, 1097)', () => {
    expect(sroCoords(97, -137)).toEqual({ x: 6433, y: 1097 })
    expect(sroCoords(0, 0)).toEqual({ x: 6336, y: 960 })
    expect(sroCoords(0, 0, { x: 169, z: 98 })).toEqual({ x: 6528, y: 1152 })
  })

  it('Home puts the camera behind the character (the world screen formula)', () => {
    expect(behindAlpha(0)).toBeCloseTo(Math.atan2(-1, -0))
    expect(behindAlpha(Math.PI / 2)).toBeCloseTo(Math.atan2(-Math.cos(Math.PI / 2), -1))
  })
})

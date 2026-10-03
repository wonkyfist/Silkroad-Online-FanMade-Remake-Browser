/**
 * UI-H (docs/UI.md §4.2, §4.5, §8; docs/WAVE_PLAN2.md §4.1 M1–M5): the retail HUD layout, the underbar geometry and
 * the wave-8 mount points, all DOM-free.
 */
import { describe, expect, it } from 'vitest'
import { buffGauge, buffSlots } from '../src/hud/buffs.ts'
import { BERSERK_HOST, BERSERK_ORBS, CHAT_SIZES, chatHeight, chatLinesFor, hudAnchors, overlaps, PARTY, PET_HOST, PLAYER_FRAME, type Rect } from '../src/hud/hud-layout.ts'
import { menuRows, type MenuBarEntry } from '../src/hud/menubar.ts'
import { cursorFor, TargetActions, targetVariant, type TargetAction, type TargetInfo } from '../src/hud/target.ts'
import { EXP_BAND, expSegmentRect, expSegments, MENU_ICON_DEFAULT, MENU_TAB, PAGE_DOWN, PAGE_UP, PANEL, PANEL_BUTTONS, slotRect, SP_GAUGE } from '../src/hud/underbar-layout.ts'
import { applyChatMode, CHANNEL_KIND, CHAT_TABS, chatCategory, chatLineFor, HIDDEN_TABS, tabSkin } from '../src/world/chat.ts'

const VIEWPORTS: [number, number][] = [
  [1024, 768],
  [1280, 720],
  [1536, 864], // 1920×1080 at 125 %
  [952, 700],
  [1366, 768],
  [1800, 1000],
]

const inside = (r: Rect, W: number, H: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W + 8 && r.y + r.h <= H

describe('hudAnchors (docs/UI.md §4.2)', () => {
  it('matches the retail resinfo rects at 1024×768', () => {
    const a = hudAnchors(1024, 768)
    expect(a.player).toEqual({ x: 4, y: 7, w: 212, h: 70 })
    expect(a.buffs).toMatchObject({ x: 220, y: 10 })
    expect(a.party).toMatchObject({ x: 4, y: 137, w: 122 })
    // GDR_TARGETWINDOW (442,10): centre + 48 at 1024.
    expect(a.target).toMatchObject({ x: 442, y: 10, w: 236 })
    // GDR_MINIMAP (892,6,140,184) = W − 132.
    expect(a.minimap).toEqual({ x: 892, y: 6, w: 140, h: 184 })
    // GDR_DELAY_GAUGE_BOARD (416,606) = centred, H − 162.
    expect(a.casting).toMatchObject({ x: 416, y: 606, w: 192, h: 36 })
    // GDR_UNDERBAR x 112; the 2009 bar flush with the bottom.
    expect(a.underbar).toEqual({ x: 112, y: 700, w: 800, h: 68 })
    expect(a.decoLeft).toEqual({ x: 36, y: 704, w: 76, h: 64 })
    expect(a.decoRight).toEqual({ x: 912, y: 704, w: 76, h: 64 })
    // M2: durability (615,5,277,32) = W − 409, equipment state (824,74,68,96) = W − 200 (decision D17).
    expect(a.durability).toEqual({ x: 615, y: 5, w: 277, h: 32 })
    expect(a.equipState).toEqual({ x: 824, y: 74, w: 68, h: 96 })
    expect(a.perf).toMatchObject({ x: 4, y: 80 })
    expect(a.quest.x + a.quest.w).toBe(1020)
  })

  it('keeps the edge offsets on other sizes', () => {
    const a = hudAnchors(1536, 864)
    expect(a.minimap.x).toBe(1536 - 132)
    expect(a.durability.x).toBe(1536 - 409)
    expect(a.equipState.x).toBe(1536 - 200)
    expect(a.underbar).toEqual({ x: 368, y: 796, w: 800, h: 68 })
    expect(a.casting).toMatchObject({ x: 672, y: 864 - 162 })
    expect(a.target.x).toBe(650 + 48)
  })

  it('nothing overlaps and everything stays on screen', () => {
    for (const [W, H] of VIEWPORTS) {
      const a = hudAnchors(W, H)
      const main: [string, Rect][] = [
        ['player', a.player],
        ['buffs', a.buffs],
        ['party', a.party],
        ['target', a.target],
        ['minimap', a.minimap],
        ['quest', a.quest],
        ['casting', a.casting],
        ['underbar', a.underbar],
        ['chat', a.chat],
      ]
      if (a.decoLeft) main.push(['decoLeft', a.decoLeft])
      if (a.decoRight) main.push(['decoRight', a.decoRight])
      for (let i = 0; i < main.length; i++) {
        expect(inside(main[i]![1], W, H), `${main[i]![0]} on screen at ${W}×${H}`).toBe(true)
        for (let j = i + 1; j < main.length; j++) {
          // The chat and the casting bar never share a column; the quest tracker is capped above the bar.
          expect(overlaps(main[i]![1], main[j]![1]), `${main[i]![0]} × ${main[j]![0]} at ${W}×${H}`).toBe(false)
        }
      }
    }
  })

  it('the chat never covers the underbar; beside it only when there is room', () => {
    for (const [W, H] of VIEWPORTS) {
      const a = hudAnchors(W, H)
      expect(overlaps(a.chat, a.underbar)).toBe(false)
      if (a.decoLeft) expect(overlaps(a.chat, a.decoLeft)).toBe(false)
      expect(a.chat.x).toBe(0)
    }
    expect(hudAnchors(1024, 768).chat.w).toBe(300)
    expect(hudAnchors(1280, 720).chat.w).toBe(400)
    expect(hudAnchors(1280, 720).chat.y + hudAnchors(1280, 720).chat.h).toBe(720 - 72)
    expect(hudAnchors(1800, 1000).chat.y + hudAnchors(1800, 1000).chat.h).toBe(1000 - 4)
  })

  it('shortens the chat on short screens instead of reaching the party frames', () => {
    const a = hudAnchors(952, 700, { chatLines: CHAT_SIZES.big })
    expect(a.chat.y).toBeGreaterThanOrEqual(PARTY.y + PARTY.h)
    expect(chatLinesFor(a)).toBeLessThan(CHAT_SIZES.big)
    const b = hudAnchors(1280, 1024, { chatLines: CHAT_SIZES.medium })
    expect(chatLinesFor(b)).toBe(CHAT_SIZES.medium)
    expect(b.chat.h).toBe(chatHeight(CHAT_SIZES.medium))
  })

  it('hides the underbar decorations below 952 native px', () => {
    expect(hudAnchors(951, 700).decoLeft).toBeNull()
    expect(hudAnchors(952, 700).decoLeft).not.toBeNull()
  })
})

describe('underbar geometry (ub_new_mainbar2, docs/UI.md §4.5)', () => {
  it('ten 32-px quick slots 36 px apart inside the bar', () => {
    for (let i = 0; i < 10; i++) {
      const r = slotRect(i)
      expect(r).toMatchObject({ y: 16, w: 32, h: 32 })
      if (i > 0) expect(r.x - slotRect(i - 1).x).toBe(36)
    }
    expect(slotRect(0).x).toBe(260)
    expect(slotRect(9).x + 32).toBeLessThan(PAGE_UP.x)
  })

  it('the EXP band: 10 segments of 76 at 19 + 78·i, y 58', () => {
    expect(expSegmentRect(0)).toEqual({ x: 19, y: 58, w: 76, h: 8 })
    expect(expSegmentRect(9).x + EXP_BAND.w).toBe(797)
  })

  it('EXP segment fills for 0, 5, 12.34, 99.99 and 100 %', () => {
    expect(expSegments(0)).toEqual(Array(10).fill(0))
    const five = expSegments(5)
    expect(five[0]).toBeCloseTo(0.5)
    expect(five.slice(1)).toEqual(Array(9).fill(0))
    const p = expSegments(12.34)
    expect(p[0]).toBe(1)
    expect(p[1]).toBeCloseTo(0.234)
    expect(p[2]).toBe(0)
    const almost = expSegments(99.99)
    expect(almost.slice(0, 9)).toEqual(Array(9).fill(1))
    expect(almost[9]).toBeCloseTo(0.999)
    expect(expSegments(100)).toEqual(Array(10).fill(1))
    expect(expSegments(Number.NaN)).toEqual(Array(10).fill(0))
  })

  it('the left box, arrows, panel and MENU tab sit where the art has them', () => {
    expect(SP_GAUGE).toEqual({ x: 15, y: 24, w: 176, h: 8 })
    expect(PAGE_DOWN.y - PAGE_UP.y).toBe(24)
    expect(MENU_TAB).toMatchObject({ x: 681, y: 1, w: 78, h: 24 })
    for (const b of PANEL_BUTTONS) {
      expect(b.x).toBeGreaterThanOrEqual(PANEL.x)
      expect(b.x + b.w).toBeLessThanOrEqual(PANEL.x + PANEL.w)
    }
  })
})

describe('M1: player-frame mount points (decision D17)', () => {
  it('petHost at (53,55,154,40); the berserk orbs inside berserkHost', () => {
    expect(PET_HOST).toEqual({ x: 53, y: 55, w: 154, h: 40 })
    expect(BERSERK_ORBS).toHaveLength(5)
    for (const o of BERSERK_ORBS) {
      expect(o.x).toBeGreaterThanOrEqual(BERSERK_HOST.x)
      expect(o.y).toBeGreaterThanOrEqual(BERSERK_HOST.y)
      expect(o.x + o.w).toBeLessThanOrEqual(BERSERK_HOST.x + BERSERK_HOST.w)
      expect(o.y + o.h).toBeLessThanOrEqual(BERSERK_HOST.y + BERSERK_HOST.h)
    }
    expect(PLAYER_FRAME).toEqual({ x: 4, y: 7, w: 212, h: 70 })
  })
})

describe('M3: target actions (decision D15)', () => {
  const player: TargetInfo = { id: 7, name: 'Mei', level: 10, hp: 1, maxHp: 1, kind: 'player' }
  const act = (id: string, show = true): TargetAction => ({ id, label: id, show: () => show, run: () => {} })

  it('two features’ actions coexist, and the deprecated setActions list replaces only its own', () => {
    const reg = new TargetActions()
    const offInvite = reg.add(act('partyInvite'))
    reg.add(act('tradeRequest'))
    expect(reg.visible(player).map(a => a.id)).toEqual(['partyInvite', 'tradeRequest'])
    reg.replace('legacy', [act('old')])
    reg.replace('legacy', [])
    expect(reg.visible(player).map(a => a.id)).toEqual(['partyInvite', 'tradeRequest'])
    offInvite()
    expect(reg.visible(player).map(a => a.id)).toEqual(['tradeRequest'])
    expect(reg.visible(null)).toEqual([])
  })

  it('a throwing show hides only that action; nothing registered shows nothing', () => {
    const reg = new TargetActions()
    expect(reg.visible(player)).toEqual([])
    reg.add({ id: 'bad', label: 'x', show: () => { throw new Error('boom') }, run: () => {} })
    reg.add(act('ok'))
    const err = console.error
    console.error = () => {}
    try {
      expect(reg.visible(player).map(a => a.id)).toEqual(['ok'])
    } finally {
      console.error = err
    }
  })

  it('picks the 2009 window per target', () => {
    expect(targetVariant({ kind: 'mob' })).toBe('enemy')
    expect(targetVariant({ kind: 'mob', variant: 'party' })).toBe('enemy')
    expect(targetVariant({ kind: 'mob', variant: 'champion' })).toBe('special')
    expect(targetVariant({ kind: 'mob', variant: 'unique' })).toBe('special')
    expect(targetVariant({ kind: 'npc' })).toBe('player')
    expect(targetVariant({ kind: 'player' })).toBe('player')
  })

  it('the cursor per hovered entity (docs/UI.md §4.10)', () => {
    expect(cursorFor(null)).toBe('normal')
    expect(cursorFor({ kind: 'mob' })).toBe('attack')
    expect(cursorFor({ kind: 'cos', own: true })).toBe('talk')
    expect(cursorFor({ kind: 'cos', own: true, dead: true })).toBe('normal')
    expect(cursorFor({ kind: 'cos' })).toBe('normal')
    expect(cursorFor({ kind: 'mob', dead: true })).toBe('normal')
    expect(cursorFor({ kind: 'npc' })).toBe('talk')
    expect(cursorFor({ kind: 'item' })).toBe('pickup')
    expect(cursorFor({ kind: 'player' })).toBe('normal')
  })
})

describe('M4: chat channels and tabs (decision D19)', () => {
  const msg = (m: object) => ({ t: 'chat' as const, text: 'hi', ...m }) as Parameters<typeof chatLineFor>[0]

  it('guild and stall channels map through the string-keyed table', () => {
    expect(CHANNEL_KIND.guild).toBe('guild')
    expect(CHANNEL_KIND.stall).toBe('stall')
    expect(chatLineFor(msg({ channel: 'guild', fromId: 7, from: 'Mei' }), 1, () => undefined)).toMatchObject({ kind: 'guild', name: 'Mei' })
    expect(chatLineFor(msg({ channel: 'stall', fromId: 7, from: 'Mei' }), 1, () => undefined)).toMatchObject({ kind: 'stall' })
    expect(chatLineFor(msg({ channel: 'party', fromId: 7, from: 'Mei' }), 1, () => undefined)).toMatchObject({ kind: 'party', label: '(Party) Mei: ' })
    expect(chatCategory('guild')).toBe('guild')
    expect(chatCategory('stall')).toBe('chat')
  })

  it('the guild tab exists and starts hidden', () => {
    expect(CHAT_TABS).toContain('guild')
    expect(HIDDEN_TABS).toEqual(['guild'])
  })

  it('tab art by label width, and the party send mode', () => {
    expect(tabSkin(20).w).toBe(52)
    expect(tabSkin(45).w).toBe(72)
    expect(tabSkin(70).w).toBe(100)
    expect(applyChatMode('party', 'hello')).toBe('#hello')
    expect(applyChatMode('party', '/w Mei hi')).toBe('/w Mei hi')
    expect(applyChatMode('party', '#hi')).toBe('#hi')
    expect(applyChatMode('all', 'hello')).toBe('hello')
  })
})

describe('M5: MENU popup rows (MenuBarEntry.icon)', () => {
  const entry = (id: string, order?: number, icon?: string): MenuBarEntry => ({ id, art: '', label: 'hud.close', order, icon, toggle: () => {}, isOpen: () => false })

  it('sorted by order, with the given icon or the default per id', () => {
    const rows = menuRows([entry('options', 90), entry('guild', 60, 'underbar/ub_new_icon_guild'), entry('character', 10), entry('custom')])
    expect(rows.map(r => r.id)).toEqual(['character', 'custom', 'guild', 'options'])
    expect(rows.find(r => r.id === 'guild')!.icon).toBe('underbar/ub_new_icon_guild')
    expect(rows.find(r => r.id === 'character')!.icon).toBe('underbar/ub_new_character')
    expect(rows.find(r => r.id === 'options')!.icon).toBe('underbar/ub_new_icon_system')
    expect(rows.find(r => r.id === 'custom')!.icon).toBe(MENU_ICON_DEFAULT)
    expect(menuRows([])).toEqual([])
  })
})

describe('buff board (GDR_MAGICSTATEBOARD)', () => {
  it('blessings on the top row, harmful effects on the second, 21 px apart, 9 per row', () => {
    const slots = buffSlots([false, true, false, true])
    expect(slots).toEqual([{ x: 0, y: 0 }, { x: 0, y: 27 }, { x: 21, y: 0 }, { x: 21, y: 27 }])
    const many = buffSlots(Array(12).fill(false))
    expect(many[8]).toEqual({ x: 168, y: 0 })
    expect(many[9]).toBeNull()
  })

  it('the time gauge runs from full to empty; toggles stay full', () => {
    expect(buffGauge({ endsAt: 2000, total: 2000 }, 0)).toBe(1)
    expect(buffGauge({ endsAt: 2000, total: 2000 }, 1500)).toBeCloseTo(0.25)
    expect(buffGauge({ endsAt: 2000, total: 2000 }, 3000)).toBe(0)
    expect(buffGauge({ endsAt: Infinity, total: Infinity }, 5)).toBe(1)
  })
})

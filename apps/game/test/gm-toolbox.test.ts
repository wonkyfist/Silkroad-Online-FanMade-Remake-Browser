import { describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { TOOL_ACTIONS, TOOL_GROUPS, actionLabel, buildAction, buildLine, groupLabel, matches, paramLabel, pushRecent } from '../src/gm/toolbox-actions.ts'

const action = (id: string) => TOOL_ACTIONS.find((a) => a.id === id)!
const missing = (k: string) => `missing ${k}`

describe('GM toolbox actions', () => {
  it('have unique ids and English labels for every action, field and group', () => {
    expect(new Set(TOOL_ACTIONS.map((a) => a.id)).size).toBe(TOOL_ACTIONS.length)
    const keys = new Set(Object.keys(en))
    for (const a of TOOL_ACTIONS) {
      expect(keys.has(actionLabel(a.id)), a.id).toBe(true)
      for (const p of a.params) expect(keys.has(paramLabel(p.key)), `${a.id}.${p.key}`).toBe(true)
    }
    for (const g of [...TOOL_GROUPS, 'all', 'fav', 'recent'] as const) expect(keys.has(groupLabel(g))).toBe(true)
  })

  it('build one gm message for a whole gear set', () => {
    const r = buildAction(action('gearset'), { degree: '3', armor: 'armor', weapon: 'blade', tier: 'sun', plus: '5', acc: 'yes', wear: 'yes', player: 'Bob' }, missing)
    expect(r).toEqual({ ok: true, msg: { t: 'gm', cmd: 'gearset', args: ['3', 'armor', 'blade', 'sun', '+5', 'wear', 'Bob'] } })
    const kit = buildAction(action('weaponkit'), {}, missing)
    expect(kit.ok && kit.msg.args).toEqual(['1', 'none', 'blade', 'noacc'])
  })

  it('default the target to yourself, and refuse a missing required field', () => {
    const r = buildAction(action('invclear'), { equipped: 'delete' }, missing)
    expect(r.ok && r.msg.args).toEqual(['.', 'all'])
    expect(buildAction(action('ban'), { player: 'Bob' }, missing)).toEqual({ ok: false, error: 'missing reason' })
    const ban = buildAction(action('ban'), { player: 'Bob', reason: 'gold   selling bot' }, missing)
    expect(ban.ok && ban.msg.args).toEqual(['Bob', 'gold selling bot'])
  })

  it('mark the destructive and global ones for a second click', () => {
    for (const id of ['invclear', 'invdrop', 'ban', 'kick', 'rewardall', 'announce', 'boost', 'killall', 'siegestart']) expect(action(id).confirm, id).toBe(true)
    for (const id of ['inv', 'heal', 'who', 'gearset']) expect(action(id).confirm, id).toBeFalsy()
  })

  it('search, the command line and recent commands', () => {
    expect(matches(action('invclear'), 'Clear the whole inventory', 'clear')).toBe(true)
    expect(matches(action('invclear'), 'Clear the whole inventory', 'weather')).toBe(false)
    expect(matches(action('lightning'), 'Lightning strike', 'weather')).toBe(true)
    expect(buildLine('/Gearset 2 protector blade')).toEqual({ ok: true, msg: { t: 'gm', cmd: 'gearset', args: ['2', 'protector', 'blade'] } })
    expect(buildLine('/bad-cmd').ok).toBe(false)
    expect(pushRecent(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
  })
})

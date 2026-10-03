/**
 * Guild persistence and pure rules (docs/SYSTEMS_SOCIAL.md §5.2, §7, §10.7; lane GU-S): create and the NOCASE unique
 * index among live guilds, a disbanded name is free again, one guild per character, leave/disband clocks, mastership
 * transfer, deleted-character pruning with the master handover, the rights bitmask round trip; and the §5.2 refusals
 * of guild-rules.ts in order.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUILD_NAME } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { isReservedName } from '../src/connection.ts'
import { openStore } from '../src/db.ts'
import {
  ALL_PERMS_BITS,
  DAY_MS,
  HOUR_MS,
  bitsToPerms,
  cleanText,
  createRefusal,
  formatWait,
  hasPerm,
  kickRefusal,
  masterOnlyRefusal,
  nameRefusal,
  penaltyLeftMs,
  permsToBits,
  titleRefusal,
  type CreateFacts,
  type MemberRights,
} from '../src/social/guild-rules.ts'
import { isUniqueError, openGuildStore } from '../src/social/guild-store.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sro-guild-store-'))
  const store = openStore(join(root, 'data'))
  const guilds = openGuildStore(store)
  let n = 0
  const acc = store.createAccount('gsacc', 'x')!
  const char = (name = `Char${++n}`) => {
    const row = store.createCharacter(acc, name, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 99)
    if (typeof row === 'string') throw new Error(row)
    return row.id
  }
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, guilds, char }
}

describe('guild store', () => {
  it('create inserts the guild and its master row (every right); guildIdOf and members read them back', () => {
    const { guilds, char } = setup()
    const a = char('Alpha')
    const id = guilds.create('Tigers', a, 1000)
    expect(guilds.guild(id)).toMatchObject({ id, name: 'Tigers', master_id: a, created_at: 1000, disbanded_at: null, notice_title: '', notice_text: '', notice_at: 0 })
    expect(guilds.guildIdOf(a)).toBe(id)
    expect(guilds.members(id)).toMatchObject([{ character_id: a, rank: 'master', perms: ALL_PERMS_BITS, title: '', joined_at: 1000, name: 'Alpha', level: 1 }])
    expect(guilds.liveByName('tIgErS')?.id).toBe(id)
    expect(guilds.liveGuilds()).toMatchObject([{ id, name: 'Tigers', members: 1 }])
  })

  it('names are unique among live guilds regardless of case (G1); a disbanded name is free again', () => {
    const { guilds, char } = setup()
    const a = char()
    const b = char()
    const id = guilds.create('Tigers', a, 1)
    let err: unknown = null
    try {
      guilds.create('TIGERS', b, 2)
    } catch (e) {
      err = e
    }
    expect(isUniqueError(err)).toBe(true)
    guilds.disband(id, 3, a)
    expect(guilds.guild(id)!.disbanded_at).toBe(3)
    expect(guilds.members(id)).toEqual([])
    expect(guilds.penalties(a).guild_disbanded_at).toBe(3)
    expect(guilds.liveByName('Tigers')).toBeUndefined()
    const again = guilds.create('tigers', b, 4)
    expect(again).not.toBe(id)
    expect(guilds.liveByName('TIGERS')?.id).toBe(again)
  })

  it('one guild per character (the member primary key)', () => {
    const { guilds, char } = setup()
    const a = char()
    const b = char()
    const g1 = guilds.create('One', a, 1)
    const g2 = guilds.create('Two', b, 1)
    let err: unknown = null
    try {
      guilds.join(g2, a, 2)
    } catch (e) {
      err = e
    }
    expect(isUniqueError(err)).toBe(true)
    expect(guilds.guildIdOf(a)).toBe(g1)
  })

  it('leave deletes the row and starts the rejoin clock; kick starts none', () => {
    const { guilds, char } = setup()
    const a = char()
    const b = char()
    const c = char()
    const id = guilds.create('Club', a, 1)
    guilds.join(id, b, 2)
    guilds.join(id, c, 3)
    guilds.leave(b, 50)
    expect(guilds.guildIdOf(b)).toBeUndefined()
    expect(guilds.penalties(b)).toEqual({ guild_left_at: 50, guild_disbanded_at: null })
    expect(guilds.kick(c)).toBe(true)
    expect(guilds.penalties(c)).toEqual({ guild_left_at: null, guild_disbanded_at: null })
    expect(guilds.kick(c)).toBe(false)
  })

  it('rights, titles, notice and mastership persist; the old master keeps every right', () => {
    const { guilds, char } = setup()
    const a = char()
    const b = char()
    const id = guilds.create('Club', a, 1)
    guilds.join(id, b, 2)
    guilds.setPerms(b, permsToBits(['invite', 'notice']))
    guilds.setTitle(b, 'Scout')
    guilds.setNotice(id, 'Hi', 'Meet at the gate', 77)
    expect(bitsToPerms(guilds.members(id)[1].perms)).toEqual(['invite', 'notice'])
    expect(guilds.members(id)[1].title).toBe('Scout')
    expect(guilds.guild(id)).toMatchObject({ notice_title: 'Hi', notice_text: 'Meet at the gate', notice_at: 77 })
    guilds.transferMaster(id, a, b)
    expect(guilds.guild(id)!.master_id).toBe(b)
    expect(guilds.members(id).map((m) => [m.character_id, m.rank, m.perms])).toEqual([[a, 'member', ALL_PERMS_BITS], [b, 'master', ALL_PERMS_BITS]])
  })

  it('rename keeps the id and refuses a live clash', () => {
    const { guilds, char } = setup()
    const one = guilds.create('One', char(), 1)
    guilds.create('Two', char(), 1)
    expect(guilds.rename(one, 'Uno')).toBe(true)
    expect(guilds.liveByName('uno')?.id).toBe(one)
    let err: unknown = null
    try {
      guilds.rename(one, 'two')
    } catch (e) {
      err = e
    }
    expect(isUniqueError(err)).toBe(true)
  })

  it('pruning deleted characters: a member goes; a deleted master hands over to the earliest joiner; an empty guild is disbanded', () => {
    const { store, guilds, char } = setup()
    const a = char()
    const b = char()
    const c = char()
    const d = char()
    const id = guilds.create('Club', a, 1)
    guilds.join(id, c, 3)
    guilds.join(id, b, 2) // joined earlier than c
    guilds.join(id, d, 4)
    const acc = store.characterById(a)!.account_id
    store.softDeleteCharacter(d, acc)
    expect(guilds.pruneDeleted()).toEqual([{ guildId: id, removed: [d], disbanded: false }])
    store.softDeleteCharacter(a, acc)
    expect(guilds.pruneDeleted(id)).toEqual([{ guildId: id, removed: [a], newMaster: b, disbanded: false }])
    expect(guilds.guild(id)!.master_id).toBe(b)
    expect(guilds.members(id).map((m) => [m.character_id, m.rank])).toEqual([[b, 'master'], [c, 'member']])
    expect(guilds.pruneDeleted()).toEqual([])
    store.softDeleteCharacter(b, acc)
    store.softDeleteCharacter(c, acc)
    expect(guilds.pruneDeleted()).toEqual([{ guildId: id, removed: [b, c], disbanded: true }])
    expect(guilds.guild(id)!.disbanded_at).not.toBeNull()
    // A deleted master starts no recreate clock.
    expect(guilds.penalties(b).guild_disbanded_at).toBeNull()
  })

  it('remove (GM expel) of the master hands over; of the last member disbands', () => {
    const { guilds, char } = setup()
    const a = char()
    const b = char()
    const id = guilds.create('Club', a, 1)
    guilds.join(id, b, 2)
    expect(guilds.remove(id, [a], 5)).toEqual({ guildId: id, removed: [a], newMaster: b, disbanded: false })
    expect(guilds.remove(id, [b], 6)).toEqual({ guildId: id, removed: [b], disbanded: true })
    expect(guilds.liveGuilds()).toEqual([])
  })
})

describe('guild rules', () => {
  it('rights bitmask round trip; the master has every right implicitly', () => {
    expect(ALL_PERMS_BITS).toBe(15)
    for (let bits = 0; bits <= 15; bits++) expect(permsToBits(bitsToPerms(bits))).toBe(bits)
    const master: MemberRights = { characterId: 1, rank: 'master', perms: [] }
    const officer: MemberRights = { characterId: 2, rank: 'member', perms: ['invite'] }
    expect(hasPerm(master, 'kick')).toBe(true)
    expect(hasPerm(officer, 'invite')).toBe(true)
    expect(hasPerm(officer, 'kick')).toBe(false)
  })

  it('GUILD_NAME and the reserved list (§10.1 cases)', () => {
    for (const ok of ['Ab', 'Tigers2', 'A12345678901']) expect(nameRefusal(ok, isReservedName), ok).toBeNull()
    for (const bad of ['1ab', 'a', 'abc_def', 'A123456789012', 'Tïgers', 'Ti gers', '']) expect(nameRefusal(bad, isReservedName)?.reason, bad).toBe('bad_name')
    expect(GUILD_NAME.test('GM1')).toBe(true)
    expect(nameRefusal('GM1', isReservedName)).toMatchObject({ reason: 'bad_name', message: 'That name is reserved.' })
    expect(nameRefusal('Admin', isReservedName)?.reason).toBe('bad_name')
  })

  it('createRefusal checks in §5.2 order: in_guild, requirements, bad_name, name_taken, cooldown, not_enough_gold', () => {
    const now = 10 * DAY_MS
    const base: CreateFacts = { inGuild: false, level: 10, minLevel: 10, name: 'Tigers', reserved: isReservedName, taken: false, disbandedAt: null, recreateDays: 0, gold: 10_000, cost: 10_000, now }
    expect(createRefusal(base)).toBeNull()
    const all: CreateFacts = { ...base, inGuild: true, level: 9, name: 'x', taken: true, disbandedAt: now - DAY_MS, recreateDays: 15, gold: 0 }
    const order: string[] = []
    let f = { ...all }
    for (const clear of [{ inGuild: false }, { level: 10 }, { name: 'Tigers' }, { taken: false }, { disbandedAt: null }, { gold: 10_000 }]) {
      order.push(createRefusal(f)?.reason ?? 'ok')
      f = { ...f, ...clear }
    }
    order.push(createRefusal(f)?.reason ?? 'ok')
    expect(order).toEqual(['in_guild', 'requirements', 'bad_name', 'name_taken', 'cooldown', 'not_enough_gold', 'ok'])
    expect(createRefusal({ ...base, level: 3 })?.message).toBe('Requires level 10.')
    // The recreate clock is off at 0 days and runs out after the span.
    expect(createRefusal({ ...base, disbandedAt: now - 1, recreateDays: 0 })).toBeNull()
    expect(createRefusal({ ...base, disbandedAt: now - 15 * DAY_MS, recreateDays: 15 })).toBeNull()
    expect(createRefusal({ ...base, disbandedAt: now - 14 * DAY_MS, recreateDays: 15 })?.message).toContain('24 hours')
  })

  it('penalty clocks and their wording', () => {
    expect(penaltyLeftMs(null, HOUR_MS, 5)).toBe(0)
    expect(penaltyLeftMs(0, 0, 5)).toBe(0)
    expect(penaltyLeftMs(100, 72 * HOUR_MS, 100 + HOUR_MS)).toBe(71 * HOUR_MS)
    expect(penaltyLeftMs(100, HOUR_MS, 100 + HOUR_MS)).toBe(0)
    expect(formatWait(71 * HOUR_MS)).toBe('71 hours')
    expect(formatWait(DAY_MS + 1)).toBe('25 hours')
    expect(formatWait(14 * DAY_MS + 1)).toBe('15 days')
    expect(formatWait(1)).toBe('1 minute')
  })

  it('kick (G4): rights needed; never yourself or the master; an officer cannot expel another officer', () => {
    const master: MemberRights = { characterId: 1, rank: 'master', perms: bitsToPerms(ALL_PERMS_BITS) }
    const officer: MemberRights = { characterId: 2, rank: 'member', perms: ['kick'] }
    const officer2: MemberRights = { characterId: 3, rank: 'member', perms: ['kick', 'invite'] }
    const member: MemberRights = { characterId: 4, rank: 'member', perms: [] }
    expect(kickRefusal(member, officer)?.reason).toBe('no_permission')
    expect(kickRefusal(officer, master)?.reason).toBe('invalid_target')
    expect(kickRefusal(officer, officer)?.reason).toBe('invalid_target')
    expect(kickRefusal(officer, officer2)?.reason).toBe('no_permission')
    expect(kickRefusal(officer, undefined)?.reason).toBe('not_found')
    expect(kickRefusal(officer, member)).toBeNull()
    expect(kickRefusal(master, officer2)).toBeNull()
  })

  it('titles: the title right; only the master titles the master; rights and mastership: master only, on another member', () => {
    const master: MemberRights = { characterId: 1, rank: 'master', perms: [] }
    const titler: MemberRights = { characterId: 2, rank: 'member', perms: ['title'] }
    const member: MemberRights = { characterId: 3, rank: 'member', perms: [] }
    expect(titleRefusal(member, titler)?.reason).toBe('no_permission')
    expect(titleRefusal(titler, member)).toBeNull()
    expect(titleRefusal(titler, titler)).toBeNull()
    expect(titleRefusal(titler, master)?.reason).toBe('no_permission')
    expect(titleRefusal(master, master)).toBeNull()
    expect(titleRefusal(master, undefined)?.reason).toBe('not_found')
    expect(masterOnlyRefusal(titler, member, 'x')?.reason).toBe('no_permission')
    expect(masterOnlyRefusal(master, master, 'x')?.reason).toBe('invalid_target')
    expect(masterOnlyRefusal(master, undefined, 'x')?.reason).toBe('not_found')
    expect(masterOnlyRefusal(master, member, 'x')).toBeNull()
  })

  it('cleanText strips control and bidi characters, trims, then counts code points', () => {
    const clean = (s: string) => s.replace(/[\u0000-\u001f‮]/g, '').trim()
    expect(cleanText('  Scout‮ ', 12, clean)).toBe('Scout')
    expect(cleanText('😀'.repeat(12), 12, clean)).toBe('😀'.repeat(12))
    expect(cleanText('😀'.repeat(13), 12, clean)).toBeNull()
  })
})

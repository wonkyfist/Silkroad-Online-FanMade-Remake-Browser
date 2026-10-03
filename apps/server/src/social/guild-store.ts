import type { GuildRank } from '@sro/shared'
import type { Store } from '../db.ts'
import { ALL_PERMS_BITS } from './guild-rules.ts'

/**
 * Guild persistence on the migration-9 tables (`guilds`, `guild_members`, `characters.guild_left_at` /
 * `guild_disbanded_at`; docs/SYSTEMS_SOCIAL.md §5.5, §7; lane GU-S), the openStorageStore pattern: statements only,
 * the SQL schema is inline in db.ts. Every write is one statement or one transaction; the guild module keeps the
 * in-memory copy in step.
 *
 * A create runs inside `store.inventoryTx(p.characterId, d => addGold(d, -cost), () => create(...))`, so the gold and
 * the guild are all or nothing. A name clash (the partial unique index `guilds_name_live`, NOCASE among live guilds)
 * throws SQLITE_CONSTRAINT_UNIQUE out of it and rolls both back; `isUniqueError` recognises it.
 */

export interface GuildRow {
  id: number
  name: string
  master_id: number
  notice_title: string
  notice_text: string
  notice_at: number
  created_at: number
  disbanded_at: number | null
}

/** A member row joined with its character (name, model, level, last_played, deleted_at). */
export interface MemberRow {
  character_id: number
  guild_id: number
  rank: GuildRank
  /** bit i = GUILD_PERMS[i] */
  perms: number
  title: string
  joined_at: number
  name: string
  model: string
  level: number
  last_played: number
  deleted_at: number | null
}

/** What pruning did to one guild (deleted characters removed; §5.2 "Deleted characters"). */
export interface PruneResult {
  guildId: number
  removed: number[]
  /** The member who took over from a deleted master (earliest joined). */
  newMaster?: number
  /** Nobody was left: the guild was disbanded. */
  disbanded: boolean
}

export type GuildStore = ReturnType<typeof openGuildStore>

/** SQLITE_CONSTRAINT_UNIQUE (and the primary-key flavour): a live guild has the name, or the character is in a guild. */
export function isUniqueError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
}

export function openGuildStore(store: Store) {
  const db = store.db
  const MEMBER_COLS = `m.character_id, m.guild_id, m.rank, m.perms, m.title, m.joined_at, c.name, c.model, c.level, c.last_played, c.deleted_at`
  const q = {
    guild: db.prepare<[number], GuildRow>('SELECT * FROM guilds WHERE id = ?'),
    liveByName: db.prepare<[string], GuildRow>('SELECT * FROM guilds WHERE name = ? AND disbanded_at IS NULL'),
    liveGuilds: db.prepare<[], GuildRow & { members: number }>(
      `SELECT g.*, (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS members
       FROM guilds g WHERE g.disbanded_at IS NULL ORDER BY g.name`,
    ),
    memberOf: db.prepare<[number], { guild_id: number }>('SELECT guild_id FROM guild_members WHERE character_id = ?'),
    members: db.prepare<[number], MemberRow>(
      `SELECT ${MEMBER_COLS} FROM guild_members m JOIN characters c ON c.id = m.character_id
       WHERE m.guild_id = ? ORDER BY m.joined_at, m.character_id`,
    ),
    deletedMembers: db.prepare<[], { character_id: number; guild_id: number }>(
      `SELECT m.character_id, m.guild_id FROM guild_members m JOIN characters c ON c.id = m.character_id
       WHERE c.deleted_at IS NOT NULL ORDER BY m.guild_id, m.character_id`,
    ),
    deletedMembersOf: db.prepare<[number], { character_id: number; guild_id: number }>(
      `SELECT m.character_id, m.guild_id FROM guild_members m JOIN characters c ON c.id = m.character_id
       WHERE m.guild_id = ? AND c.deleted_at IS NOT NULL ORDER BY m.character_id`,
    ),
    penalties: db.prepare<[number], { guild_left_at: number | null; guild_disbanded_at: number | null }>(
      'SELECT guild_left_at, guild_disbanded_at FROM characters WHERE id = ?',
    ),
    insertGuild: db.prepare<[string, number, number]>('INSERT INTO guilds (name, master_id, created_at) VALUES (?, ?, ?)'),
    insertMember: db.prepare<[number, number, GuildRank, number, number]>(
      'INSERT INTO guild_members (character_id, guild_id, rank, perms, joined_at) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteMember: db.prepare<[number]>('DELETE FROM guild_members WHERE character_id = ?'),
    deleteMembersOf: db.prepare<[number]>('DELETE FROM guild_members WHERE guild_id = ?'),
    setLeftAt: db.prepare<[number, number]>('UPDATE characters SET guild_left_at = ? WHERE id = ?'),
    setDisbandedAt: db.prepare<[number, number]>('UPDATE characters SET guild_disbanded_at = ? WHERE id = ?'),
    setPerms: db.prepare<[number, number]>('UPDATE guild_members SET perms = ? WHERE character_id = ?'),
    setTitle: db.prepare<[string, number]>('UPDATE guild_members SET title = ? WHERE character_id = ?'),
    setRank: db.prepare<[GuildRank, number, number]>('UPDATE guild_members SET rank = ?, perms = ? WHERE character_id = ?'),
    setMaster: db.prepare<[number, number]>('UPDATE guilds SET master_id = ? WHERE id = ?'),
    setNotice: db.prepare<[string, string, number, number]>('UPDATE guilds SET notice_title = ?, notice_text = ?, notice_at = ? WHERE id = ?'),
    setDisbanded: db.prepare<[number, number]>('UPDATE guilds SET disbanded_at = ? WHERE id = ? AND disbanded_at IS NULL'),
    rename: db.prepare<[string, number]>('UPDATE guilds SET name = ? WHERE id = ?'),
  }

  /** Mastership from `from` to `to` (both members of `guildId`): ranks swap, the old master keeps every right. */
  const transferTx = db.transaction((guildId: number, from: number | null, to: number) => {
    if (from !== null) q.setRank.run('member', ALL_PERMS_BITS, from)
    q.setRank.run('master', ALL_PERMS_BITS, to)
    q.setMaster.run(to, guildId)
  })

  /** Disbands: disbanded_at, every member row deleted, and the recreate clock of `penalize` (null = none, e.g. a GM). */
  const disbandTx = db.transaction((guildId: number, now: number, penalize: number | null) => {
    q.setDisbanded.run(now, guildId)
    q.deleteMembersOf.run(guildId)
    if (penalize !== null) q.setDisbandedAt.run(now, penalize)
  })

  /** Leave: the member row goes and the rejoin clock starts. */
  const leaveTx = db.transaction((characterId: number, now: number) => {
    q.deleteMember.run(characterId)
    q.setLeftAt.run(now, characterId)
  })

  /**
   * Removes `characterIds` from `guildId` (deleted characters, or a GM kick). A removed master hands over to the member
   * who joined earliest; a guild left empty is disbanded (no recreate clock).
   */
  const removeTx = db.transaction((guildId: number, characterIds: number[], now: number): PruneResult => {
    const g = q.guild.get(guildId)
    const out: PruneResult = { guildId, removed: [], disbanded: false }
    if (!g || g.disbanded_at !== null) return out
    for (const id of characterIds) if (q.deleteMember.run(id).changes > 0) out.removed.push(id)
    const rest = q.members.all(guildId).filter((m) => m.deleted_at === null)
    if (rest.length === 0) {
      disbandTx(guildId, now, null)
      out.disbanded = true
    } else if (!rest.some((m) => m.rank === 'master') || out.removed.includes(g.master_id)) {
      transferTx(guildId, null, rest[0].character_id)
      out.newMaster = rest[0].character_id
    }
    return out
  })

  return {
    db,
    guild: (id: number) => q.guild.get(id),
    /** The live guild with this name (case-insensitive). */
    liveByName: (name: string) => q.liveByName.get(name),
    /** Every live guild with its member count, by name. */
    liveGuilds: () => q.liveGuilds.all(),
    /** The guild id of a character, or undefined. */
    guildIdOf: (characterId: number): number | undefined => q.memberOf.get(characterId)?.guild_id,
    /** A guild's members (with their characters), in join order. */
    members: (guildId: number) => q.members.all(guildId),
    penalties: (characterId: number) => q.penalties.get(characterId) ?? { guild_left_at: null, guild_disbanded_at: null },
    /** Inserts a guild and its master row (no transaction of its own: call it inside inventoryTx's `extra`). Throws on a name clash. */
    create(name: string, masterId: number, now: number): number {
      const id = Number(q.insertGuild.run(name, masterId, now).lastInsertRowid)
      q.insertMember.run(masterId, id, 'master', ALL_PERMS_BITS, now)
      return id
    },
    join: (guildId: number, characterId: number, now: number) => void q.insertMember.run(characterId, guildId, 'member', 0, now),
    leave: (characterId: number, now: number) => leaveTx(characterId, now),
    /** A kick: the row goes, no rejoin clock (§5.2). */
    kick: (characterId: number) => q.deleteMember.run(characterId).changes > 0,
    setPerms: (characterId: number, bits: number) => void q.setPerms.run(bits, characterId),
    setTitle: (characterId: number, title: string) => void q.setTitle.run(title, characterId),
    setNotice: (guildId: number, title: string, text: string, at: number) => void q.setNotice.run(title, text, at, guildId),
    transferMaster: (guildId: number, from: number, to: number) => transferTx(guildId, from, to),
    disband: (guildId: number, now: number, penalize: number | null) => disbandTx(guildId, now, penalize),
    /** Renames a live guild. Throws on a name clash (isUniqueError). */
    rename: (guildId: number, name: string) => q.rename.run(name, guildId).changes > 0,
    remove: (guildId: number, characterIds: number[], now: number) => removeTx(guildId, characterIds, now),
    /** Removes deleted characters from one guild (`guildId`) or from every guild; one result per guild touched. */
    pruneDeleted(guildId?: number, now = Date.now()): PruneResult[] {
      const rows = guildId === undefined ? q.deletedMembers.all() : q.deletedMembersOf.all(guildId)
      const byGuild = new Map<number, number[]>()
      for (const r of rows) byGuild.set(r.guild_id, [...(byGuild.get(r.guild_id) ?? []), r.character_id])
      return [...byGuild].map(([gid, ids]) => removeTx(gid, ids, now))
    },
  }
}

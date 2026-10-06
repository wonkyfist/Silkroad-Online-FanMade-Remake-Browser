/**
 * Migrations v8 (combat and items, docs/SYSTEMS_COMBAT.md §6.2) and v9 (social, docs/SYSTEMS_SOCIAL.md §7), landed by
 * W8-F (docs/WAVE_PLAN2.md §2.6): a v7 database on a temp DATA_DIR migrates to v9 keeping its data; the new columns,
 * tables, indexes and constraints exist; Store.hwanPoints is the D34 source.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, migrate, openStore } from '../src/db.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** A v7 database with one account, two characters, an item and a quest, copied into a fresh DATA_DIR. */
function v7Copy(): string {
  const root = mkdtempSync(join(tmpdir(), 'sro-migrate-w8-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const v7Dir = join(root, 'v7')
  const copyDir = join(root, 'data')
  mkdirSync(v7Dir)
  mkdirSync(copyDir)
  const v7 = new Database(join(v7Dir, 'game.db'))
  expect(migrate(v7, 7)).toBe(7)
  v7.exec(`INSERT INTO accounts (id, username, password_hash, created_at, role) VALUES (1, 'veteran', 'x', 1, 'gm');
    INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at, gold) VALUES (1, 1, 'Ryu', 'CHAR_CH_MAN_ADVENTURER', 'spear', 12, 'jangan', 1, 4321);
    INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at) VALUES (2, 1, 'Mei', 'CHAR_CH_WOMAN_ADVENTURER', 'bow', 3, 'jangan', 2);
    INSERT INTO items (character_id, equip_slot, code, count, plus, durability) VALUES (1, 'weapon', 'ITEM_CH_SPEAR_01_A', 1, 3, 10);
    INSERT INTO quest_done (character_id, quest, last_at) VALUES (1, 'JG_001', 9);`)
  expect(() => v7.prepare('SELECT hwan_points FROM characters').all()).toThrow()
  expect(() => v7.prepare('SELECT * FROM guilds').all()).toThrow()
  v7.close()
  copyFileSync(join(v7Dir, 'game.db'), join(copyDir, 'game.db'))
  return copyDir
}

const cols = (db: Database.Database, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
const indexes = (db: Database.Database, t: string) => (db.prepare(`PRAGMA index_list(${t})`).all() as { name: string }[]).map((i) => i.name).sort()

describe('migrations v8 and v9 (wave 8)', () => {
  it('upgrades a v7 database to v9 and keeps its data', () => {
    const store = openStore(v7Copy())
    cleanups.push(() => store.close())
    expect(SCHEMA_VERSION).toBe(16)
    expect(store.schemaVersion).toBe(16)
    expect(store.db.pragma('user_version', { simple: true })).toBe(16)
    expect(store.characterById(1)).toMatchObject({ name: 'Ryu', level: 12, gold: 4321, hwan_points: 0, guild_left_at: null, guild_disbanded_at: null })
    expect(store.loadInventory(1).equip.weapon).toEqual({ code: 'ITEM_CH_SPEAR_01_A', count: 1, plus: 3, durability: 10 })
    expect(store.accountRole(1)).toBe('gm')
    expect(store.db.prepare('SELECT quest, times FROM quest_done').get()).toEqual({ quest: 'JG_001', times: 1 })
  })

  it('v8: characters.hwan_points (0..5) and char_mount', () => {
    const store = openStore(v7Copy())
    cleanups.push(() => store.close())
    const db = store.db
    expect(cols(db, 'characters')).toEqual(expect.arrayContaining(['hwan_points']))
    expect(cols(db, 'char_mount')).toEqual(['character_id', 'code', 'hp', 'mounted'])
    // D34 source: Store.hwanPoints / setHwanPoints (clamped to 0..5).
    expect(store.hwanPoints(1)).toBe(0)
    expect(store.setHwanPoints(1, 4)).toBe(true)
    expect(store.hwanPoints(1)).toBe(4)
    store.setHwanPoints(1, 9)
    expect(store.hwanPoints(1)).toBe(5)
    expect(store.hwanPoints(999)).toBe(0)
    expect(() => db.prepare('UPDATE characters SET hwan_points = 6 WHERE id = 1').run()).toThrow(/CHECK/)
    db.prepare("INSERT INTO char_mount (character_id, code, hp) VALUES (1, 'COS_C_HORSE1', 800)").run()
    expect(db.prepare('SELECT * FROM char_mount').get()).toEqual({ character_id: 1, code: 'COS_C_HORSE1', hp: 800, mounted: 1 })
    expect(() => db.prepare("INSERT INTO char_mount (character_id, code, hp) VALUES (2, 'COS_C_HORSE1', 0)").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO char_mount (character_id, code, hp, mounted) VALUES (2, 'COS_C_HORSE1', 5, 2)").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO char_mount (character_id, code, hp) VALUES (1, 'COS_C_HORSE1', 5)").run()).toThrow(/UNIQUE|PRIMARY/)
    expect(() => db.prepare("INSERT INTO char_mount (character_id, code, hp) VALUES (77, 'COS_C_HORSE1', 5)").run()).toThrow(/FOREIGN KEY/)
  })

  it('v9: guilds, guild_members, the penalty clocks and social_log, with their indexes', () => {
    const store = openStore(v7Copy())
    cleanups.push(() => store.close())
    const db = store.db
    expect(cols(db, 'guilds')).toEqual(['id', 'name', 'master_id', 'notice_title', 'notice_text', 'notice_at', 'created_at', 'disbanded_at'])
    expect(cols(db, 'guild_members')).toEqual(['character_id', 'guild_id', 'rank', 'perms', 'title', 'joined_at'])
    expect(cols(db, 'characters')).toEqual(expect.arrayContaining(['guild_left_at', 'guild_disbanded_at']))
    expect(cols(db, 'social_log')).toEqual(['id', 'at', 'kind', 'a_char', 'b_char', 'a_gold', 'b_gold', 'a_items', 'b_items'])
    expect(indexes(db, 'guilds')).toContain('guilds_name_live')
    expect(indexes(db, 'guild_members')).toContain('guild_members_guild')
    expect(indexes(db, 'social_log')).toEqual(expect.arrayContaining(['social_log_a', 'social_log_at', 'social_log_b']))

    // Names are unique among live guilds, case-insensitively; a disbanded guild frees its name (G1).
    db.prepare("INSERT INTO guilds (id, name, master_id, created_at) VALUES (1, 'Tigers', 1, 5)").run()
    expect(() => db.prepare("INSERT INTO guilds (name, master_id, created_at) VALUES ('TIGERS', 2, 6)").run()).toThrow(/UNIQUE/)
    db.prepare('UPDATE guilds SET disbanded_at = 7 WHERE id = 1').run()
    db.prepare("INSERT INTO guilds (id, name, master_id, created_at) VALUES (2, 'tigers', 2, 8)").run()
    expect(db.prepare('SELECT notice_title, notice_text, notice_at FROM guilds WHERE id = 2').get()).toEqual({ notice_title: '', notice_text: '', notice_at: 0 })

    // One guild per character; rank and perms are checked.
    db.prepare("INSERT INTO guild_members (character_id, guild_id, rank, joined_at) VALUES (2, 2, 'master', 8)").run()
    expect(db.prepare('SELECT perms, title FROM guild_members').get()).toEqual({ perms: 0, title: '' })
    expect(() => db.prepare("INSERT INTO guild_members (character_id, guild_id, rank, joined_at) VALUES (2, 2, 'member', 9)").run()).toThrow(/UNIQUE|PRIMARY/)
    expect(() => db.prepare("INSERT INTO guild_members (character_id, guild_id, rank, joined_at) VALUES (1, 2, 'vice', 9)").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO guild_members (character_id, guild_id, rank, perms, joined_at) VALUES (1, 2, 'member', 16, 9)").run()).toThrow(/CHECK/)
    db.prepare("INSERT INTO guild_members (character_id, guild_id, rank, perms, joined_at) VALUES (1, 2, 'member', 15, 9)").run()

    db.prepare('UPDATE characters SET guild_left_at = 11, guild_disbanded_at = 12 WHERE id = 1').run()
    expect(store.characterById(1)).toMatchObject({ guild_left_at: 11, guild_disbanded_at: 12 })

    db.prepare("INSERT INTO social_log (at, kind, a_char, b_char, a_gold) VALUES (1, 'trade', 1, 2, 50)").run()
    expect(db.prepare('SELECT kind, a_gold, b_gold, a_items, b_items FROM social_log').get()).toEqual({ kind: 'trade', a_gold: 50, b_gold: 0, a_items: '[]', b_items: '[]' })
    expect(() => db.prepare("INSERT INTO social_log (at, kind, a_char, b_char) VALUES (1, 'gift', 1, 2)").run()).toThrow(/CHECK/)
  })

  it('a fresh database is created at v9, and a v9 database opens again unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-fresh-w8-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const first = openStore(root)
    expect(first.schemaVersion).toBe(16)
    first.close()
    const again = openStore(root)
    expect(again.schemaVersion).toBe(16)
    again.close()
  })
})

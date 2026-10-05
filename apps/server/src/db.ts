import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DEFAULT_HEIGHT, DEFAULT_VOLUME, EQUIP_SLOTS, type EquipSlot, type Role, type StarterOutfit, type StarterWeapon } from '@sro/shared'
import { InvDraft, type InvItem, type InvState, type Result } from './inventory.ts'
import type { Progress } from './progression.ts'

/**
 * SQLite persistence. Migrations are append-only: each entry runs once, in order, inside a
 * transaction, and PRAGMA user_version records how many have run.
 */
const MIGRATIONS: string[] = [
  // 1: accounts, sessions, characters
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_account ON sessions(account_id);
  CREATE INDEX sessions_expiry ON sessions(expires_at);
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL COLLATE NOCASE,
    model TEXT NOT NULL,
    weapon TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    exp INTEGER NOT NULL DEFAULT 0,
    x REAL,
    y REAL,
    z REAL,
    yaw REAL NOT NULL DEFAULT 0,
    world TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_played INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER
  );
  -- Names are unique (case-insensitive) among live characters; a soft delete frees the name.
  CREATE UNIQUE INDEX characters_name_live ON characters(name COLLATE NOCASE) WHERE deleted_at IS NULL;
  CREATE INDEX characters_account ON characters(account_id);
  `,
  // 2: GM system: account roles and the GM command audit log
  `
  ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'gm', 'admin'));
  CREATE TABLE gm_audit (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    character_id INTEGER,
    command TEXT NOT NULL,
    args TEXT NOT NULL,
    result TEXT NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX gm_audit_at ON gm_audit(at);
  CREATE INDEX gm_audit_account ON gm_audit(account_id);
  `,
  // 3: gameplay: character stats and items (docs/PROTOCOL.md §4, §7)
  `
  ALTER TABLE characters ADD COLUMN sp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE characters ADD COLUMN sp_exp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE characters ADD COLUMN strength INTEGER NOT NULL DEFAULT 20;
  ALTER TABLE characters ADD COLUMN intellect INTEGER NOT NULL DEFAULT 20;
  ALTER TABLE characters ADD COLUMN stat_points INTEGER NOT NULL DEFAULT 0 CHECK (stat_points >= 0);
  ALTER TABLE characters ADD COLUMN gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0);
  -- NULL = full (a new character, or one saved before HP existed)
  ALTER TABLE characters ADD COLUMN hp INTEGER;
  ALTER TABLE characters ADD COLUMN mp INTEGER;
  ALTER TABLE characters ADD COLUMN dead INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE characters ADD COLUMN bag_size INTEGER NOT NULL DEFAULT 48 CHECK (bag_size BETWEEN 1 AND 96);
  -- 1 once the starter weapon and clothes were handed out (at creation, or at the first entry after items.json exists)
  ALTER TABLE characters ADD COLUMN starter_kit INTEGER NOT NULL DEFAULT 0;
  -- Characters levelled before stats existed (GM setlevel) get the per-level growth they would have had.
  UPDATE characters SET strength = 19 + level, intellect = 19 + level, stat_points = 3 * (level - 1) WHERE level > 1;
  -- One row per stack. Exactly one of bag_slot (0-based bag index) or equip_slot (EquipSlot name) is set,
  -- and each is unique per character, so an item can never be in two places.
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    bag_slot INTEGER CHECK (bag_slot >= 0),
    equip_slot TEXT,
    code TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 1),
    plus INTEGER NOT NULL DEFAULT 0 CHECK (plus >= 0),
    durability INTEGER,
    CHECK ((bag_slot IS NULL) <> (equip_slot IS NULL)),
    UNIQUE (character_id, bag_slot),
    UNIQUE (character_id, equip_slot)
  );
  CREATE INDEX items_character ON items(character_id);
  `,
  // 4: appearance (character creation Height/Volume, starter outfit) and the navmesh surface of the saved position
  `
  ALTER TABLE characters ADD COLUMN height INTEGER NOT NULL DEFAULT 2 CHECK (height BETWEEN 0 AND 4);
  ALTER TABLE characters ADD COLUMN volume INTEGER NOT NULL DEFAULT 2 CHECK (volume BETWEEN 0 AND 4);
  ALTER TABLE characters ADD COLUMN outfit TEXT NOT NULL DEFAULT 'clothes' CHECK (outfit IN ('clothes', 'light', 'heavy'));
  -- docs/NAVIGATION.md §5.1: the surface under (x, z) ('t' terrain, 'o:<object world id>:<cell>'); NULL = locate from y
  ALTER TABLE characters ADD COLUMN nav_surface TEXT;
  `,
  // 5: skills and masteries (docs/SKILLS.md §10.1; docs/WAVE_PLAN.md decision 8: cooldowns are not persisted)
  `
  CREATE TABLE char_masteries (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    code TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 300),
    PRIMARY KEY (character_id, code)
  );
  CREATE TABLE char_skills (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    -- skills.json group, e.g. SKILL_CH_SWORD_SMASH_A
    grp TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level >= 1),
    PRIMARY KEY (character_id, grp)
  );
  CREATE TABLE char_hotbar (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 39),
    kind TEXT NOT NULL CHECK (kind IN ('skill', 'item')),
    code TEXT NOT NULL,
    PRIMARY KEY (character_id, slot)
  );
  `,
  // 6: account storage (docs/SHOPS.md §5.2): account-wide chest and its gold
  `
  CREATE TABLE storage_items (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    slot INTEGER NOT NULL CHECK (slot >= 0),
    code TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 1),
    plus INTEGER NOT NULL DEFAULT 0 CHECK (plus >= 0),
    durability INTEGER,
    UNIQUE (account_id, slot)
  );
  CREATE INDEX storage_items_account ON storage_items(account_id);
  ALTER TABLE accounts ADD COLUMN storage_gold INTEGER NOT NULL DEFAULT 0 CHECK (storage_gold >= 0);
  ALTER TABLE accounts ADD COLUMN storage_size INTEGER NOT NULL DEFAULT 150 CHECK (storage_size BETWEEN 1 AND 180);
  `,
  // 7: quests (docs/QUESTS.md §1.4, verbatim): per-character state, completions and the quest bag. Statements live
  // in quests/store.ts. (The wave-4 reservation of 8 was never used; wave 8 took 8 and 9, docs/WAVE_PLAN2.md §2.6.)
  `
  CREATE TABLE quest_state (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    quest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'ready')),
    rev INTEGER NOT NULL DEFAULT 0,            -- QuestDef.rev the counts belong to
    counts TEXT NOT NULL DEFAULT '{}',         -- JSON {objectiveId: count}; collect counts are derived from quest_items
    accepted_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, quest)
  );
  CREATE TABLE quest_done (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    quest TEXT NOT NULL,
    times INTEGER NOT NULL DEFAULT 1 CHECK (times >= 1),
    last_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, quest)
  );
  -- The quest bag: quest items belong to one active quest and vanish with it.
  CREATE TABLE quest_items (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    quest TEXT NOT NULL,
    code TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 1),
    PRIMARY KEY (character_id, quest, code)
  );
  `,
  // 8: combat and items (docs/SYSTEMS_COMBAT.md §6.2, verbatim): Berserk points and the saved horse. The points are read
  // through hwanPoints/setHwanPoints below (the Berserk module's per-character cache, D34); the char_mount statements
  // live in mounts.ts. Durability and plus already live in items / storage_items.
  `
  ALTER TABLE characters ADD COLUMN hwan_points INTEGER NOT NULL DEFAULT 0 CHECK (hwan_points BETWEEN 0 AND 5);
  CREATE TABLE char_mount (
    character_id INTEGER PRIMARY KEY REFERENCES characters(id),
    code TEXT NOT NULL,                 -- CosDef.code, e.g. COS_C_HORSE1
    hp INTEGER NOT NULL CHECK (hp >= 1),
    mounted INTEGER NOT NULL DEFAULT 1 CHECK (mounted IN (0, 1))
  );
  `,
  // 9: social systems (docs/SYSTEMS_SOCIAL.md §7, verbatim): guilds, guild members, penalties, trade/stall log.
  // Statements live in social/guild-store.ts (and the log insert in the trade/stall modules).
  `
  CREATE TABLE guilds (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    master_id INTEGER NOT NULL REFERENCES characters(id),
    notice_title TEXT NOT NULL DEFAULT '',
    notice_text TEXT NOT NULL DEFAULT '',
    notice_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    disbanded_at INTEGER
  );
  -- Unique among live guilds, case-insensitive; a disbanded guild frees its name (the characters_name_live pattern).
  CREATE UNIQUE INDEX guilds_name_live ON guilds(name COLLATE NOCASE) WHERE disbanded_at IS NULL;
  CREATE TABLE guild_members (
    character_id INTEGER PRIMARY KEY REFERENCES characters(id),   -- one guild per character
    guild_id INTEGER NOT NULL REFERENCES guilds(id),
    rank TEXT NOT NULL CHECK (rank IN ('master', 'member')),
    perms INTEGER NOT NULL DEFAULT 0 CHECK (perms BETWEEN 0 AND 15),  -- bit i = GUILD_PERMS[i]
    title TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL
  );
  CREATE INDEX guild_members_guild ON guild_members(guild_id);
  -- Penalty clocks (config GUILD_REJOIN_HOURS / GUILD_RECREATE_DAYS; NULL = never)
  ALTER TABLE characters ADD COLUMN guild_left_at INTEGER;
  ALTER TABLE characters ADD COLUMN guild_disbanded_at INTEGER;
  -- Every completed exchange and stall sale (GM audits; never read by gameplay)
  CREATE TABLE social_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trade', 'stall')),
    a_char INTEGER NOT NULL,           -- trade: requester; stall: buyer
    b_char INTEGER NOT NULL,           -- trade: accepter;  stall: owner
    a_gold INTEGER NOT NULL DEFAULT 0, -- gold a gave
    b_gold INTEGER NOT NULL DEFAULT 0, -- gold b gave
    a_items TEXT NOT NULL DEFAULT '[]', -- JSON ItemStack[] a gave
    b_items TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX social_log_at ON social_log(at);
  CREATE INDEX social_log_a ON social_log(a_char);
  CREATE INDEX social_log_b ON social_log(b_char);
  `,
  // 10: unique monsters as world bosses (docs/UNIQUES.md §5.2, docs/WAVE_PLAN7.md §3.3, verbatim): one row per unique,
  // written on spawn, death and GM changes only. Statements live in uniques.ts (UniqueRow below).
  `
  CREATE TABLE uniques (
    code TEXT PRIMARY KEY,              -- MOB_CH_TIGERWOMAN
    phase TEXT NOT NULL,                -- 'waiting' | 'alive'
    due_at INTEGER NOT NULL DEFAULT 0,  -- ms epoch of the next spawn while waiting
    camp INTEGER,                       -- nest id of the current or last camp
    spawns INTEGER NOT NULL DEFAULT 0,
    last_killer TEXT,
    last_killed_at INTEGER
  );
  `,
  // 11: the mouse quick slot (retail GDR_TMPQS_0, docs/UI.md): one entry per character beside the 40 hotbar slots,
  // used by the middle mouse button. Its own table so char_hotbar (slot 0..39) stays as it is.
  `
  CREATE TABLE char_mouse_slot (
    character_id INTEGER PRIMARY KEY REFERENCES characters(id),
    kind TEXT NOT NULL CHECK (kind IN ('skill', 'item')),
    code TEXT NOT NULL
  );
  `,
  // 12: Play the Boss, layer 1 (docs/PLAY_THE_BOSS.md §5.3, verbatim): the events, their log, and the play-time counter
  // the layer-4 lottery reads (it accrues from now on; no back-fill). Statements live in pilot/store.ts.
  `
  CREATE TABLE pilot_events (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL,                 -- MOB_CH_TIGERWOMAN
    origin TEXT NOT NULL,               -- 'schedule' | 'gm' | 'admin'
    phase TEXT NOT NULL,                -- 'call' | 'draw' | 'hunt' | 'ended'
    created_at INTEGER NOT NULL,
    call_ends_at INTEGER, hunt_started_at INTEGER, hunt_ends_at INTEGER, ended_at INTEGER,
    outcome TEXT,                       -- HuntEventView.outcome
    pilot_account INTEGER, pilot_character INTEGER, pilot_name TEXT,
    camp INTEGER,
    downs INTEGER NOT NULL DEFAULT 0,
    hunters INTEGER NOT NULL DEFAULT 0, -- distinct non-associates who hit her
    steered_ms INTEGER NOT NULL DEFAULT 0,
    reward_gold INTEGER NOT NULL DEFAULT 0,
    refunded INTEGER NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]',   -- e.g. ["suspect_associates_31pct","pilot_left"]
    stats TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX pilot_events_created ON pilot_events(created_at);
  CREATE INDEX pilot_events_pilot ON pilot_events(pilot_account);
  CREATE TABLE pilot_log (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES pilot_events(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- offer, accept, decline, timeout, spawn, takeover, ai, player, down, end, reward, flag, gm
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX pilot_log_event ON pilot_log(event_id);
  ALTER TABLE characters ADD COLUMN played_ms INTEGER NOT NULL DEFAULT 0;
  `,
  // 13: Play the Boss, layer 3 (docs/PLAY_THE_BOSS.md §3.9, §5.4's pilot_honors moved up): titles won as the boss
  // ("Spirit of the Tiger"), permanent, shown as EntityState.honor. Statements live in pilot/store.ts.
  `
  CREATE TABLE pilot_honors (
    character_id INTEGER NOT NULL REFERENCES characters(id),
    code TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (character_id, code)
  );
  `,
  // 14: Play the Boss, layer 4 (docs/PLAY_THE_BOSS.md §5.4; pilot_honors landed in 13): the admin panel's settings patch
  // over the content defaults (one row per unique, `rev` for stale-save checks), the volunteers of each call (one per
  // account; `draw` = how the draw treated them) and the lottery blocks. Statements live in pilot/store.ts.
  `
  CREATE TABLE pilot_settings (
    code TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER
  );
  CREATE TABLE pilot_volunteers (
    event_id INTEGER NOT NULL REFERENCES pilot_events(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    draw TEXT,                          -- null, offered, accepted, declined, timeout, left, skipped:<why>
    PRIMARY KEY (event_id, account_id)
  );
  CREATE TABLE pilot_blocks (
    account_id INTEGER PRIMARY KEY,
    until INTEGER NOT NULL,
    reason TEXT NOT NULL,
    by_account INTEGER,
    at INTEGER NOT NULL
  );
  `,
  // 15: the "What's new" window (docs/CHANGELOG_WINDOW.md): per account, the newest changelog entry it acknowledged
  // ("Got it"), as that entry's date (yyyy-mm-dd[Thh:mm]) and id. NULL = never; then the entries dated from the
  // account's creation day on count as unseen (shared/news.ts unseenNews).
  `
  ALTER TABLE accounts ADD COLUMN news_seen_date TEXT;
  ALTER TABLE accounts ADD COLUMN news_seen_id TEXT;
  `,
]

/** A row of the `uniques` table (migration 10; read and written by uniques.ts). */
export interface UniqueRow {
  code: string
  phase: 'waiting' | 'alive'
  /** ms epoch of the next spawn while waiting (0 = not scheduled). */
  due_at: number
  /** Nest id of the current or last camp. */
  camp: number | null
  spawns: number
  last_killer: string | null
  last_killed_at: number | null
}

/** Schema version after every migration (PRAGMA user_version of an up-to-date database). */
export const SCHEMA_VERSION = MIGRATIONS.length

export interface AccountRow {
  id: number
  username: string
  password_hash: string
  role: Role
}

export interface AuditRow {
  id: number
  at: number
  account_id: number
  /** The account's username at read time (joined). */
  username: string
  character_id: number | null
  command: string
  /** JSON array of the arguments as given. */
  args: string
  result: string
  ok: 0 | 1
}

export interface AuditEntry {
  accountId: number
  characterId: number | null
  command: string
  args: string[]
  result: string
  ok: boolean
}

export interface CharacterRow {
  id: number
  account_id: number
  name: string
  model: string
  weapon: StarterWeapon
  level: number
  exp: number
  /** null until the character first enters the world (it then spawns at the spawn point). */
  x: number | null
  y: number | null
  z: number | null
  yaw: number
  world: string
  created_at: number
  last_played: number
  deleted_at: number | null
  // migration 3
  sp: number
  sp_exp: number
  strength: number
  intellect: number
  stat_points: number
  gold: number
  /** null = full */
  hp: number | null
  mp: number | null
  dead: 0 | 1
  bag_size: number
  starter_kit: 0 | 1
  // migration 4
  height: number
  volume: number
  outfit: StarterOutfit
  /** Navmesh surface of the saved position (nav.ts surfaceKey), or null. */
  nav_surface: string | null
  // migration 8
  /** Berserk points 0..5 (read through Store.hwanPoints; the Berserk module caches them, D34). */
  hwan_points: number
  // migration 9
  /** ms the character last left a guild (rejoin penalty), or null. */
  guild_left_at: number | null
  /** ms the character last disbanded a guild (recreate penalty), or null. */
  guild_disbanded_at: number | null
  // migration 12
  /** ms spent in the world (Play the Boss eligibility; accrues from migration 12 on, added at every save). */
  played_ms: number
}

/** Character creation choices (docs/CHARACTER_SCALE.md; protocol charCreate). */
export interface Appearance {
  height: number
  volume: number
  outfit: StarterOutfit
}

export const DEFAULT_APPEARANCE: Appearance = { height: DEFAULT_HEIGHT, volume: DEFAULT_VOLUME, outfit: 'clothes' }

interface ItemRow {
  id: number
  character_id: number
  bag_slot: number | null
  equip_slot: EquipSlot | null
  code: string
  count: number
  plus: number
  durability: number | null
}

/** Saved state of a character in the world (periodic saves, leave, shutdown). */
export interface CharacterSave {
  id: number
  x: number
  y: number
  z: number
  yaw: number
  world: string
  lastPlayed: number
  hp: number
  mp: number
  dead: boolean
  /** Navmesh surface key (nav.ts surfaceKey); null/absent = unknown. */
  surface?: string | null
  /** ms in the world since the last save, added to characters.played_ms (migration 12); absent = 0. */
  playedMs?: number
}

/** Runs the pending migrations (up to `upTo`, default all; tests build older schemas with it). Returns the version reached. */
export function migrate(db: Database.Database, upTo = MIGRATIONS.length): number {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema v${current} is newer than this server (v${MIGRATIONS.length})`)
  }
  const target = Math.min(upTo, MIGRATIONS.length)
  for (let v = current; v < target; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return Math.max(current, target)
}

export type Store = ReturnType<typeof openStore>

/** `mustExist`: fail instead of creating an empty database (the gm CLI). */
export function openStore(dataDir: string, opts: { mustExist?: boolean } = {}) {
  // Owner-only on POSIX: the database holds password hashes and session hashes.
  if (!opts.mustExist) mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new Database(join(dataDir, 'game.db'), { fileMustExist: opts.mustExist === true })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  const schemaVersion = migrate(db)

  const q = {
    accountByName: db.prepare<[string], AccountRow>('SELECT id, username, password_hash, role FROM accounts WHERE username = ?'),
    accountById: db.prepare<[number], AccountRow>('SELECT id, username, password_hash, role FROM accounts WHERE id = ?'),
    accountRole: db.prepare<[number], { role: Role }>('SELECT role FROM accounts WHERE id = ?'),
    setRole: db.prepare<[Role, number]>('UPDATE accounts SET role = ? WHERE id = ?'),
    staff: db.prepare<[], { id: number; username: string; role: Role; last_login: number | null }>(
      "SELECT id, username, role, last_login FROM accounts WHERE role != 'player' ORDER BY username",
    ),
    insertAudit: db.prepare<[number, number, number | null, string, string, string, number]>(
      'INSERT INTO gm_audit (at, account_id, character_id, command, args, result, ok) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    recentAudit: db.prepare<[number], AuditRow>(
      `SELECT g.*, a.username FROM gm_audit g JOIN accounts a ON a.id = g.account_id ORDER BY g.id DESC LIMIT ?`,
    ),
    liveCharacterRowByName: db.prepare<[string], CharacterRow>('SELECT * FROM characters WHERE name = ? AND deleted_at IS NULL'),
    setLevel: db.prepare<[number, number]>('UPDATE characters SET level = ? WHERE id = ?'),
    insertAccount: db.prepare<[string, string, number]>('INSERT INTO accounts (username, password_hash, created_at) VALUES (?, ?, ?)'),
    touchLogin: db.prepare<[number, number]>('UPDATE accounts SET last_login = ? WHERE id = ?'),
    insertSession: db.prepare<[string, number, number, number]>(
      'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ),
    sessionAccount: db.prepare<[string, number], AccountRow>(
      `SELECT a.id, a.username, a.password_hash, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    ),
    deleteSession: db.prepare<[string]>('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare<[number]>('DELETE FROM sessions WHERE expires_at <= ?'),
    trimSessions: db.prepare<[number, number, number]>(
      `DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (
         SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ),
    liveCharacters: db.prepare<[number], CharacterRow>(
      'SELECT * FROM characters WHERE account_id = ? AND deleted_at IS NULL ORDER BY id',
    ),
    liveCharacterCount: db.prepare<[number], { n: number }>(
      'SELECT COUNT(*) AS n FROM characters WHERE account_id = ? AND deleted_at IS NULL',
    ),
    liveCharacterByName: db.prepare<[string], { id: number }>(
      'SELECT id FROM characters WHERE name = ? AND deleted_at IS NULL',
    ),
    characterOwned: db.prepare<[number, number], CharacterRow>(
      'SELECT * FROM characters WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
    ),
    insertCharacter: db.prepare<[number, string, string, string, string, number, number, number, string]>(
      `INSERT INTO characters (account_id, name, model, weapon, world, created_at, height, volume, outfit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    characterById: db.prepare<[number], CharacterRow>('SELECT * FROM characters WHERE id = ?'),
    softDelete: db.prepare<[number, number, number]>(
      'UPDATE characters SET deleted_at = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
    ),
    savePosition: db.prepare<[number, number, number, number, string, number, number]>(
      'UPDATE characters SET x = ?, y = ?, z = ?, yaw = ?, world = ?, last_played = ? WHERE id = ?',
    ),
    saveCharacter: db.prepare<[number, number, number, number, string, number, number, number, number, string | null, number]>(
      'UPDATE characters SET x = ?, y = ?, z = ?, yaw = ?, world = ?, last_played = ?, hp = ?, mp = ?, dead = ?, nav_surface = ? WHERE id = ?',
    ),
    saveProgress: db.prepare<[number, number, number, number, number, number, number, number]>(
      'UPDATE characters SET level = ?, exp = ?, sp = ?, sp_exp = ?, strength = ?, intellect = ?, stat_points = ? WHERE id = ?',
    ),
    items: db.prepare<[number], ItemRow>('SELECT * FROM items WHERE character_id = ? ORDER BY id'),
    deleteBagSlot: db.prepare<[number, number]>('DELETE FROM items WHERE character_id = ? AND bag_slot = ?'),
    deleteEquipSlot: db.prepare<[number, string]>('DELETE FROM items WHERE character_id = ? AND equip_slot = ?'),
    insertItem: db.prepare<[number, number | null, string | null, string, number, number, number | null]>(
      'INSERT INTO items (character_id, bag_slot, equip_slot, code, count, plus, durability) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    setGold: db.prepare<[number, number]>('UPDATE characters SET gold = ? WHERE id = ?'),
    setStarterKit: db.prepare<[number]>('UPDATE characters SET starter_kit = 1 WHERE id = ?'),
    // migration 8 (docs/WAVE_PLAN2.md D34)
    hwanPoints: db.prepare<[number], { hwan_points: number }>('SELECT hwan_points FROM characters WHERE id = ?'),
    setHwanPoints: db.prepare<[number, number]>('UPDATE characters SET hwan_points = ? WHERE id = ?'),
    // migration 12 (docs/PLAY_THE_BOSS.md §5.3)
    addPlayed: db.prepare<[number, number]>('UPDATE characters SET played_ms = played_ms + ? WHERE id = ?'),
    // migration 15 (docs/CHANGELOG_WINDOW.md)
    newsMark: db.prepare<[number], { created_at: number; news_seen_date: string | null; news_seen_id: string | null }>(
      'SELECT created_at, news_seen_date, news_seen_id FROM accounts WHERE id = ?',
    ),
    setNewsMark: db.prepare<[string, string, number]>('UPDATE accounts SET news_seen_date = ?, news_seen_id = ? WHERE id = ?'),
  }

  function loadInventory(characterId: number): InvState {
    const row = q.characterById.get(characterId)
    if (!row) throw new Error(`no character ${characterId}`)
    const bag: (InvItem | null)[] = Array.from({ length: row.bag_size }, () => null)
    const equip: InvState['equip'] = {}
    for (const r of q.items.all(characterId)) {
      const it: InvItem = { code: r.code, count: r.count, plus: r.plus, durability: r.durability }
      if (r.bag_slot !== null && r.bag_slot < row.bag_size) bag[r.bag_slot] = it
      else if (r.equip_slot !== null && EQUIP_SLOTS.includes(r.equip_slot)) equip[r.equip_slot] = it
    }
    return { bagSize: row.bag_size, bag, equip, gold: row.gold }
  }

  function writeDraft(characterId: number, d: InvDraft): void {
    for (const slot of d.touchedBag) {
      q.deleteBagSlot.run(characterId, slot)
      const it = d.bag[slot]
      if (it) q.insertItem.run(characterId, slot, null, it.code, it.count, it.plus, it.durability)
    }
    for (const slot of d.touchedEquip) {
      q.deleteEquipSlot.run(characterId, slot)
      const it = d.equip[slot]
      if (it) q.insertItem.run(characterId, null, slot, it.code, it.count, it.plus, it.durability)
    }
    if (d.goldChanged) q.setGold.run(d.gold, characterId)
  }

  /**
   * Runs one inventory operation atomically: loads the character's items and gold, lets `fn` change a draft,
   * and writes back the touched slots only when `fn` succeeded (inside one SQLite transaction; a throw rolls
   * everything back). `extra` runs in the same transaction after the write (e.g. saving progress).
   */
  function inventoryTx<T>(characterId: number, fn: (d: InvDraft) => Result<T>, extra?: () => void): { result: Result<T>; draft: InvDraft } {
    const out = {} as { result: Result<T>; draft: InvDraft }
    db.transaction(() => {
      out.draft = new InvDraft(loadInventory(characterId))
      out.result = fn(out.draft)
      if (out.result.ok) {
        if (out.draft.changed) writeDraft(characterId, out.draft)
        extra?.()
      }
    })()
    return out
  }

  const saveCharactersTx = db.transaction((rows: CharacterSave[]) => {
    for (const r of rows) {
      q.saveCharacter.run(r.x, r.y, r.z, r.yaw, r.world, r.lastPlayed, Math.round(r.hp), Math.round(r.mp), r.dead ? 1 : 0, r.surface ?? null, r.id)
      if (r.playedMs && r.playedMs > 0) q.addPlayed.run(Math.round(r.playedMs), r.id)
    }
  })

  /** Equips the starter kit once (no-op when already given or `items` is empty). Returns whether it was given. */
  const starterKitTx = db.transaction((characterId: number, items: { code: string; slot: EquipSlot }[]): boolean => {
    const row = q.characterById.get(characterId)
    if (!row || row.starter_kit || items.length === 0) return false
    const taken = new Set(q.items.all(characterId).map((r) => r.equip_slot))
    for (const it of items) if (!taken.has(it.slot)) q.insertItem.run(characterId, null, it.slot, it.code, 1, 0, null)
    q.setStarterKit.run(characterId)
    return true
  })

  const createCharacterTx = db.transaction(
    (accountId: number, name: string, model: string, weapon: string, world: string, maxSlots: number, now: number, look: Appearance) => {
      if (q.liveCharacterCount.get(accountId)!.n >= maxSlots) return 'slots_full' as const
      if (q.liveCharacterByName.get(name)) return 'name_taken' as const
      const r = q.insertCharacter.run(accountId, name, model, weapon, world, now, look.height, look.volume, look.outfit)
      return q.characterById.get(Number(r.lastInsertRowid))!
    },
  )

  const savePositionsTx = db.transaction(
    (rows: { id: number; x: number; y: number; z: number; yaw: number; world: string; lastPlayed: number }[]) => {
      for (const r of rows) q.savePosition.run(r.x, r.y, r.z, r.yaw, r.world, r.lastPlayed, r.id)
    },
  )

  return {
    db,
    schemaVersion,
    accountByName: (username: string) => q.accountByName.get(username),
    accountById: (id: number) => q.accountById.get(id),
    /** Returns the new account id, or null if the username is taken (case-insensitive). */
    createAccount(username: string, passwordHash: string, now = Date.now()): number | null {
      try {
        return Number(q.insertAccount.run(username, passwordHash, now).lastInsertRowid)
      } catch (e) {
        if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null
        throw e
      }
    },
    touchLogin: (accountId: number, now = Date.now()) => q.touchLogin.run(now, accountId),
    createSession: (tokenHash: string, accountId: number, expiresAt: number, now = Date.now()) =>
      q.insertSession.run(tokenHash, accountId, now, expiresAt),
    sessionAccount: (tokenHash: string, now = Date.now()) => q.sessionAccount.get(tokenHash, now),
    deleteSession: (tokenHash: string) => q.deleteSession.run(tokenHash).changes > 0,
    purgeSessions: (now = Date.now()) => q.purgeSessions.run(now).changes,
    /** Revokes all but the newest `keep` sessions of an account. */
    trimSessions: (accountId: number, keep: number) => q.trimSessions.run(accountId, accountId, keep).changes,
    characters: (accountId: number) => q.liveCharacters.all(accountId),
    characterOwned: (id: number, accountId: number) => q.characterOwned.get(id, accountId),
    nameInUse: (name: string) => q.liveCharacterByName.get(name) !== undefined,
    createCharacter(accountId: number, name: string, model: string, weapon: StarterWeapon, world: string, maxSlots: number, look: Partial<Appearance> = {}) {
      try {
        return createCharacterTx(accountId, name, model, weapon, world, maxSlots, Date.now(), {
          height: look.height ?? DEFAULT_APPEARANCE.height,
          volume: look.volume ?? DEFAULT_APPEARANCE.volume,
          outfit: look.outfit ?? DEFAULT_APPEARANCE.outfit,
        })
      } catch (e) {
        if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return 'name_taken' as const
        throw e
      }
    },
    softDeleteCharacter: (id: number, accountId: number) => q.softDelete.run(Date.now(), id, accountId).changes > 0,
    savePositions: savePositionsTx,
    /** Current role straight from the database (a CLI grant/revoke is visible at once). */
    accountRole: (accountId: number): Role => q.accountRole.get(accountId)?.role ?? 'player',
    setRole: (accountId: number, role: Role) => q.setRole.run(role, accountId).changes > 0,
    /** Accounts whose role is not 'player'. */
    staff: () => q.staff.all(),
    audit(e: AuditEntry, now = Date.now()): void {
      q.insertAudit.run(now, e.accountId, e.characterId, e.command, JSON.stringify(e.args), e.result.slice(0, 1000), e.ok ? 1 : 0)
    },
    recentAudit: (limit: number) => q.recentAudit.all(limit),
    characterByName: (name: string) => q.liveCharacterRowByName.get(name),
    setLevel: (characterId: number, level: number) => q.setLevel.run(level, characterId).changes > 0,
    characterById: (id: number) => q.characterById.get(id),
    /** Positions plus HP/MP/death of characters in the world. */
    saveCharacters: saveCharactersTx,
    saveProgress: (characterId: number, p: Progress) =>
      q.saveProgress.run(p.level, p.exp, p.sp, p.spExp, p.str, p.int, p.statPoints, characterId).changes > 0,
    loadInventory,
    /** Writes a draft's touched slots and gold (no transaction of its own: call it inside one, e.g. storage-db.ts storageTx). */
    writeDraft,
    inventoryTx,
    grantStarterKit: (characterId: number, items: { code: string; slot: EquipSlot }[]) => starterKitTx(characterId, items),
    /**
     * Berserk points of a character (0..5; 0 when unknown). The source of the Berserk module's per-character cache
     * (docs/WAVE_PLAN2.md D34): `stats` goes out before the modules' `enter`, so the module reads through this.
     */
    hwanPoints: (characterId: number): number => q.hwanPoints.get(characterId)?.hwan_points ?? 0,
    /** Saves Berserk points (clamped to 0..5). */
    setHwanPoints: (characterId: number, points: number) =>
      q.setHwanPoints.run(Math.max(0, Math.min(5, Math.round(points))), characterId).changes > 0,
    /** The account's "What's new" seen mark (null = never acknowledged) and creation time; null for no such account. */
    newsMark(accountId: number): { createdAt: number; mark: { date: string; id: string } | null } | null {
      const r = q.newsMark.get(accountId)
      if (!r) return null
      return { createdAt: r.created_at, mark: r.news_seen_date && r.news_seen_id ? { date: r.news_seen_date, id: r.news_seen_id } : null }
    },
    setNewsMark: (accountId: number, mark: { date: string; id: string }) => q.setNewsMark.run(mark.date, mark.id, accountId).changes > 0,
    /** Changes whenever another connection (e.g. the gm CLI) commits to the database. */
    dataVersion: () => db.pragma('data_version', { simple: true }) as number,
    close: () => db.close(),
  }
}

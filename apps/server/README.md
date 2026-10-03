# @sro/server

The authoritative game server. It is one Node process with an HTTP account API, the WebSocket game protocol, and a SQLite database. The protocol it implements is `packages/shared/src/protocol.ts` (v1). The runtime validators it uses are in `packages/shared/src/validate.ts`.

- **HTTP**:
  - `POST /api/register`, `POST /api/login` and `POST /api/logout` handle accounts.
  - `GET /api/servers` lists the server, and `GET /health` reports its status.
- **WebSocket** `/ws`: the first frame must be `hello {version, token}`.
- **Static files** (production): the built client (`apps/game/dist`) is served at `/`, the converted assets (`work/out`) at `/out/` and the optimized assets (`work/out-opt`, docs/ASSETS.md) at `/out-opt/`. See "Static serving" below.
- **SQLite** is stored in `DATA_DIR/game.db`, with versioned migrations (`PRAGMA user_version`).

Gameplay and saved data refer to content by CodeName128 ids (`CHAR_CH_MAN_ADVENTURER`), never by file paths.

## Run in development

```sh
pnpm install                          # once; pnpm fetches Node 24.21.0 (.npmrc use-node-version)
pnpm --filter @sro/server dev         # or: pnpm server   (tsx watch, restarts on change)
pnpm --filter @sro/game dev           # the client; Vite proxies /api and /ws to localhost:7000
```

Always run Node through pnpm (`pnpm exec`, `pnpm tsx`, `pnpm vitest`), because a bare `node` may be an older system Node.

Tests start real servers on ephemeral ports, each with a temporary `DATA_DIR`:

```sh
pnpm vitest run apps/server/test packages/shared/test
```

### Soak test

`apps/server/test/soak/soak.ts` is a script, not part of `pnpm test`. It forks the real server (`soak-host.ts`: the same `loadConfig` + `startServer` as `src/main.ts`, plus instruments) on a free port with a temporary `DATA_DIR` and `WORLD_EXPORT=jangan-fields`. It then drives 25 bots for 20 minutes of wall time, each on its own loopback address (127.0.0.x):

- 8 grinders fight in the Grassland: they walk there, attack, pick up loot, drink potions, buy more, die, respawn and walk back.
- 6 questers play Act I of "The Tiger's Shadow". At the end of the chain they delete the character and start a new one.
- 3 shoppers use shops (buy, sell, buyback) and storage (items and gold).
- 2 party pairs invite, share kills, use party chat, leave and re-invite.
- 2 chatters send local chat and whispers.
- 1 GM runs `skill all` and casts at monsters.
- 1 GM uses the nest editor (`nest add` / `near` / `undo`).

On top of that come disconnect/reconnect churn (each bot 5% per minute) and a graceful server restart at 40% of the run. Bots walk like the client, as straight `moveTo` legs along A* routes over the real navmesh (`planner.ts`).

```sh
pnpm tsx apps/server/test/soak/soak.ts                       # 20 minutes; exit code 0 = pass
pnpm tsx apps/server/test/soak/soak.ts --minutes 3           # a quick smoke run
#   --restart-at 0.4 (fraction of the run, 0 = no restart)  --sample-s 30  --seed 1  --out report.json  --keep (keep DATA_DIR)
```

Every 30 s it prints a sample of the server process. A sample holds RSS, heap used (also after a forced GC), event-loop lag, tick mean/p99/max, entity counts, the size of every Map/Set of the world and the gameplay modules, open handles by type, and the DB/WAL size. At the end it prints a summary and writes a JSON report (default `work/tmp/soak/soak-<time>.json`).

The run passes when all of these hold:

- no crash;
- no unhandled rejection or uncaught exception;
- no error-level log line and no stderr output;
- no `server_error` sent to a client;
- every character re-enters where it was saved after the restart;
- the heap after GC grows less than 10% over the last 10 minutes after warm-up (2 minutes after each start);
- tick p99 is under 20 ms.

On Windows the event-loop lag has a floor of about 16 ms, which is the system timer resolution, so it is informational only.

### New-player playtest

`apps/server/test/soak/newplayer.ts` is also a script, not part of `pnpm test`. One bot plays "The Tiger's Shadow" from Soldier Fengil at real speed, with the real `loadConfig` defaults, no GM commands and no speed-ups. It starts its own server in-process on a free port with a temporary `DATA_DIR` and `WORLD_EXPORT=jangan-fields`, then uses only the socket and what the client knows (NPC positions, `GET /api/quests`, item and skill data). It walks by clicking waypoints around walls (`newplayer-route.ts`, A* over the navmesh), fights with basic attacks and Strike Smash, drinks and buys potions, loots, sells junk, and spends stat points and SP. It logs every friction point: long walks, sparse hunting spots, deaths, refused requests and server errors. The JSON report (default `work/tmp/newplayer-report.json`) records how long each quest took and the level reached.

```sh
pnpm tsx apps/server/test/soak/newplayer.ts                  # 40 minutes, a fresh character
pnpm tsx apps/server/test/soak/newplayer.ts --minutes 5      # a quick smoke run
#   --data work/tmp/np/char-a (keep DATA_DIR; running again continues the same character)  --out report.json  --debug (print routes)
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7000` | HTTP/WebSocket port (`0` = pick a free one) |
| `HOST` | `127.0.0.1` (dev), `0.0.0.0` (production) | Listen address. On the mini PC, prefer the Tailscale IP. |
| `NODE_ENV` | | `production` turns static serving on and changes the `HOST` default |
| `DATA_DIR` | `<repo>/work/server` | Where `game.db` (and its WAL files) live. A relative path is resolved against the directory you ran `pnpm` from. |
| `OUT_DIR` | `<repo>/work/out` | Converted assets, served at `/out/`. Also read for the world manifest, its navmesh (`nav.bin`) and the character list. |
| `OUT_OPT_DIR` | `<repo>/work/out-opt` | Optimized assets (`optimize-out.ts run --precompress`), served at `/out-opt/`. Also a fallback place for the world navmesh. |
| `NAV` | `auto` | `auto`: walk on the world's navmesh (manifest `nav` entry, `OUT_DIR/world/<WORLD_EXPORT>/nav.bin`) when it exists, else on the flat world bounds. `off`: always flat. The startup log says which (`navigation: ...`). |
| `GAME_DIST` | `<repo>/apps/game/dist` | Built game client, served at `/` |
| `SERVE_STATIC` | on when `NODE_ENV=production` | `1`/`0` forces static serving on or off |
| `WORLD` | `jangan` | World id: the `world` of nests, NPCs, towns and saved characters, the `tp <world>` place and the server id. Also the default `WORLD_EXPORT` of any world but `jangan`. |
| `WORLD_EXPORT` | `jangan-fields` when `OUT_DIR/world/jangan-fields/` exists (world `jangan`), else `WORLD` | World export folder: `OUT_DIR/world/<WORLD_EXPORT>/` (manifest, `nav.bin`), sent to the client as `ServerInfo.world` and `worldEnter.world.name` so it loads the same folder. `jangan-fields` = the 307-region fields around Jangan (streamed by the client), `jangan-near` = the 5 × 5 regions around town. Lower-case letters, digits and `-` only. See "World exports". |
| `NEST_COUNT_SCALE` | `1` | Monsters per nest × this (0.1–1; every nest keeps at least 1; unique monsters are unchanged). For a quieter `jangan-fields`. |
| `MOVE_SPEED` | `5.5` | Run speed in m/s |
| `TICK_HZ` | `10` | Simulation ticks per second (1–60) |
| `SPAWN_X`, `SPAWN_Z` | see below | Spawn point for new characters, in world metres |
| `CAPACITY` | `50` | Maximum players in the world, also shown on server select |
| `REGISTER_LIMIT` | `10` | Registrations allowed per IP per hour |
| `SAVE_INTERVAL` | `30` | Seconds between periodic position saves |
| `LEVEL_CAP` | `20` | Level cap: no EXP past it; also the highest level GM `setlevel` accepts |
| `VIEW_RANGE` | `120` | Interest radius in metres: a client receives entities within it (despawn at +10 m) |
| `MOB_LEVEL_MAX` | `LEVEL_CAP + 5` | Nests whose monster is above this level stay empty (`0` = spawn every level) |
| `SPAWN_MOBS` | `1` | `0` = no nest monsters (GM `spawn` still works) |
| `GIANT_PCT` | `1` | Percent chance a nest monster with a giant variant spawns as a giant |
| `EXP_RATE` | `1` | Kill EXP × this (0–1000; every share of a kill, solo or party). Quest EXP is not rated, so a higher rate raises the quests' share of levelling. See `docs/BALANCE.md` §7. |
| `SP_RATE` | `1` | Kill SP-EXP × this (0–1000). Keep it equal to `EXP_RATE` to keep the SP-per-level curve of `docs/BALANCE.md` §5. Quest SP is not rated. |
| `GOLD_RATE` | `1` | Dropped gold × this (0–1000; `0` = no gold drops). Quest gold and shop prices are unchanged. |
| `DROP_RATE` | `1` | Chance of every item group of a monster's drop table × this (0–1000, each chance stops at 100 %). Gold (`GOLD_RATE`) and quest item drops are unchanged. |
| `CORS_ORIGIN` | (none) | Sets `Access-Control-Allow-Origin` on `/api/*`. It is only needed if the client is served from another origin without a proxy. |
| `ALLOWED_ORIGINS` | (none) | Extra browser origins (comma-separated, e.g. `http://100.64.0.5:5180`) allowed to call `/api` and open `/ws`. The server's own origin (Origin host = Host header), the Vite dev/preview origins (`http://localhost:5180`, `:5181`, also 127.0.0.1 and [::1]) and `CORS_ORIGIN` are always allowed; requests without an Origin header (curl) are allowed; anything else gets 403. |
| `TRUST_PROXY` | `0` | `1` = take the client IP from `X-Forwarded-For`. Enable it only behind your own reverse proxy. |

**Spawn point.** New characters appear at the spawn point, and dead characters respawn there (it is the town return point). It is chosen by the first rule that applies (implemented in `src/content.ts`, `resolveWorld` and `withTownSpawn`):

1. `SPAWN_X`/`SPAWN_Z` from the environment.
2. The world manifest's `spawn` field: `[x, y, z]`, `[x, z]` or `{x, y, z}`.
3. The return point of this world's town in `OUT_DIR/data/towns.json` (for Jangan: the client's teleportdata gate, about 97, -137). The town's `safeArea` rectangle is where fighting is off (see "Gameplay").
4. The centre of the manifest's centre region. This is the region in `regions[]` whose grid coordinates are nearest the median of all listed regions. A region's rectangle comes from:
   - its own `bounds`/`min`/`max`; or
   - `offset` (its min corner) plus 192 m; or
   - the origin rule: with `origin: [ox, oz]` in region coordinates, region `(rx, rz)` spans x ∈ [(rx−ox)·192, +192] and z ∈ [−(rz−oz)·192 − 192, −(rz−oz)·192]. Z is mirrored into glTF space.

   Regions may be given as `{x, z}`, `{rx, rz}`, `{id}` (with id = z << 8 | x) or `{region: [x, z]}`.
5. The centre of the manifest's `bounds`.
6. `(0, 0)`.

The startup log line says which rule was used. The world bounds are the manifest's `bounds` or the union of the region rectangles. When known, they clamp every move target.

**Playable models.** Character creation accepts the same models the client offers:

- `OUT_DIR/data/characters.json` (written by `pnpm tsx packages/convert/src/tools/export-data.ts`) is authoritative when it exists: its entries flagged `selectable`/`playable`/`creatable`, or unflagged and one of the 26 Chinese player models (`PLAYER_MODELS_CH`). Today that is all 26.
- Only when it is missing: Chinese player models present in `OUT_DIR/index.json`, plus `CHAR_CH_MAN_ADVENTURER` and `CHAR_CH_WOMAN_ADVENTURER`.

European models (`CHAR_EU_*`) are rejected. Both files are re-read when they change. The startup log says how many models were loaded and from which file.

## Security notes

- Passwords: scrypt N=2^15, r=8, p=1, 16-byte salt, NFC-normalized; parameters are stored per hash, so older hashes keep working. At most 4 hashes run at once (32 queued); beyond that the API answers 503 `rate_limited`.
- Login: 5 failed attempts per IP+username and 50 per IP per 15 minutes. Attempts are counted before the hash, so parallel bursts cannot slip past. An unknown user costs the same hash as a known one.
- Sessions: 256-bit random tokens; only their SHA-256 is stored. They expire after 7 days, and each account keeps at most 10 (the oldest are revoked). `POST /api/logout` also closes a game socket that uses that token.
- Origins: see `ALLOWED_ORIGINS`. Other websites cannot call the API or open game sockets from a player's browser.
- WebSocket: hello within 5 s; frames of 1 KB or less (up to 4 KB answers `bad_request`, larger closes 1009); 20 msg/s; at most 16 sockets per IP; one socket per account (a new login kicks the old one, close 4000).
- Gameplay: every request is validated strictly (`packages/shared/src/validate.ts`), rate limited per type and answered by exactly one `actionResult`. Targets and pickups must be entities the client has been sent (interest), are reached by the server walking the player there at the world move speed, and are re-checked when the swing or pickup happens. A world tick that throws is logged (`world tick failed`) instead of stopping the server.
- Registration is open to anyone who can reach the port. Keep the server on the tailnet (below).

## Gameplay rules implemented

- **Accounts**:
  - usernames are 3–16 characters from `[A-Za-z0-9_]` and are unique regardless of case;
  - passwords are 6–64 characters, hashed with scrypt (N=16384, r=8, p=1) using a per-user salt, and compared in constant time;
  - an unknown user costs the same scrypt work as a wrong password;
  - after 5 failed logins per IP+username in 15 minutes (or 50 per IP), login answers `429 rate_limited`;
  - a login token is valid for 7 days, and the server stores only its SHA-256;
  - `POST /api/register` answers `201 {token, expiresAt}`, so the new account is already logged in.
- **Sockets**:
  - the first frame must be `hello` within 5 s, or the socket is closed with 4003;
  - a bad token closes with 4001, and a wrong version with 4002;
  - each account has one socket, so a new login kicks the old one: that socket gets an `error` and then close 4000;
  - clients should not auto-reconnect after 4000.
- **Frames**:
  - text frames are JSON, validated strictly (exact keys, typed, bounded);
  - bad, unknown, binary, or over-1 KB frames get `error bad_request`, and frames over 4 KB close the socket with 1009;
  - there are 20 messages/s per connection (burst 40), and extra messages get `rate_limited`;
  - after 20 rejected frames the socket is closed with 4008.
- **Characters**:
  - names follow `CHARACTER_NAME` (3–12 characters, starting with a letter) and are unique regardless of case among live characters;
  - a few names (admin, gm, system, …) are reserved;
  - an account has at most 4 characters;
  - `charDelete` is a soft delete (`deleted_at`), and it frees the name.
- **World**:
  - `enterWorld` places the character at its saved position, or at the spawn point if it has never played;
  - it answers with `worldEnter`, whose `entities` lists every entity within `VIEW_RANGE`, then `stats` and `inventory`;
  - interest management: each client receives `spawn` when an entity (player, monster, NPC, ground item) comes within `VIEW_RANGE` metres, and `despawn` once it is more than 10 m beyond that or gone. Every other message about an entity (`move`, `stop`, `combat`, `entityUpdate`, ...) goes only to clients that have it.
  - `moveTo` starts a straight line from the server's interpolated position at `MOVE_SPEED`:
    - the target is clamped to the world bounds;
    - the move is walked on the navmesh (see "Navigation") and ends at the first blocking edge;
    - the move is broadcast as `move` to everyone, including the mover;
    - the tick loop broadcasts `stop` on arrival.
  - Yaw is `atan2(dx, dz)`, so yaw 0 faces +Z.
  - Positions are saved every `SAVE_INTERVAL` seconds, on leave, on disconnect (at the interpolated position) and on shutdown.
- **Gameplay**: see "Gameplay" below.
- **Chat**:
  - chat is local, which for now means everyone in the world, and the sender receives an echo;
  - messages are at most 100 characters;
  - control and bidi-override characters are stripped;
  - the rate is 1 line/s (burst 5).
- **Ping**: `ping` answers `pong` with `serverTime`, for clock sync.
- **GM**: see "Game Masters" above. A kick closes the socket with 4010.

## Game Masters (GM)

Every account has a role: `player` (the default for new registrations), `gm` or `admin`. GMs and admins may run GM commands; an admin also outranks a gm (a gm cannot `kick`, `summon` or `setlevel` an admin). No command changes a role: only the `pnpm gm` CLI, which needs the server's database file, does. The role is stored in `accounts.role` (migration v2) and sent to the client in `welcome.role` and `worldEnter.role`.

### Granting the role

```sh
pnpm gm grant <username> [--role gm|admin]   # default role: gm
pnpm gm revoke <username>                    # back to player
pnpm gm list                                 # every gm/admin account
pnpm gm audit [--limit N]                    # the most recent GM commands (default 20)
```

The CLI works on `DATA_DIR/game.db` (the same `DATA_DIR` as the server) and is safe to run while the server is up (SQLite WAL). It refuses to create a database that does not exist. On the mini PC, run it as the service user with the service's data directory, e.g. `sudo -u sro env DATA_DIR=/var/lib/silkroad pnpm gm grant dayan`.

**When a change applies.** Immediately. GM commands re-read the role from the database on every call, so a revoke can never be outrun. The server also polls `PRAGMA data_version` every second; when the CLI has written, it re-reads the roles of connected accounts and sends `{t: 'role', role}` to anyone whose role changed. A revoked GM also becomes visible again and drops back to normal speed.

### Commands

Send `{t: 'gm', cmd, args}` (cmd `/^[a-z]{1,16}$/`, at most 8 args of at most 100 characters), or type the same thing in chat as a slash command: `/tp 100 -100`, `/notice Server restart in 5 minutes`. Slash lines are never broadcast. The reply is `gmResult {ok, cmd, message, data?}`. A non-GM gets `error forbidden` instead, both for `gm` messages and for slash lines. Every call, allowed or denied, is written to the `gm_audit` table (`at, account_id, character_id, command, args` as JSON, `result, ok`).

Limits: GM commands (`gm` frames and slash lines together) have their own budget of 5/s per connection (burst 20), for GMs too; beyond it the reply is `error rate_limited`. Slash lines from players also pay the chat budget. The game client never sends a `gm` frame for a player, so each refused `gm` frame (and each over-budget one) counts as a strike toward the 20-strike disconnect (4008), which also bounds the audit rows a player can cause. Positions from `tp`/`summon` must be finite and are clamped to the world bounds (±1,000,000 m without bounds). `notice` text and `kick` reasons lose control and bidi characters; a notice is at most 300 code points. Long `gmResult` messages are cut at 7,900 characters.

| Command | Effect |
|---|---|
| `help` | Lists the commands (`data.commands`). |
| `who` | Online players with character, account, level, position and region (`data.players`). |
| `where [player]` | Position and region of a player, or of yourself. |
| `tp <x> <z>` | Teleport to world metres, clamped to the world bounds. |
| `tp <place>` | Teleport to a named place: the world name (`jangan`) and `spawn` are the spawn point. The manifest may add more under `places`, `teleports`, `landmarks` or `locations` (an array of `{name, pos}` or an object mapping name to `[x, y, z]`/`[x, z]`/`{x, z}`). `tp` alone lists them. |
| `tp <player>` | Teleport to an online player. Places win over player names; write `@Name` to force a player. |
| `summon <player>` | Brings the player to 1 m in front of you. |
| `kick <player> [reason]` | Sends the target a system chat line, then closes its socket with **4010** (`CLOSE_CODE.kicked`). The name may also be an account in the lobby. |
| `notice <text>` | Server-wide `notice {text, from}` to every connected socket, lobby included (at most 300 characters). |
| `setlevel <player> <1..LEVEL_CAP>` | Saved at once; works for offline characters too; EXP into the level resets to 0. **Raising** gives what a player earns on the way: +1 STR, +1 INT and 3 free stat points per level (the level-up rule of `gainExp`), and the SP a typical player owns at that level at SP_RATE 1 minus what one owns at the old level (`TYPICAL_SP_BY_LEVEL` in `progression.ts`, from docs/BALANCE.md §4: level 5 = 10, 10 = 118, 12 = 250, 16 = 894, 20 = 2,530; past level 20 each level adds its EXP / 400). **Lowering** takes back the automatic +1 STR / +1 INT per level (never below 20) and the removed levels' free stat points only as far as they are unspent (spent points stay in STR/INT); SP, SP-EXP and learned skills are never taken. Raising again grants the SP again. Nothing is silent: the reply names every change ("is now level 12 (STR +11, INT +11, stat points +33, SP +250)"), `data` has `{player, level, online, from, sp, statPoints}`, and the same message is the `gm_audit` result. Online players are refilled and get `entityUpdate {id, level, hp, maxHp}` to everyone who sees them, plus `stats`. |
| `speed <0.5..5>` | Your own move speed multiplier (runtime only, reset when you leave the world). A move in progress is re-issued at the new speed. `speed` alone shows it. |
| `invis <on\|off>` | Players get `despawn` (and later `spawn`); other GMs and you get `entityUpdate {invisible}` and see `invisible: true` in the entity state. Your moves reach only GMs meanwhile. Runtime only. Local chat still reaches everyone. |
| `heal [player]` | Full HP/MP for yourself or a player (rank rules apply); also revives a dead player where it stands. |
| `spawn <mob code> [n]` | Spawns 1-50 monsters of a `mobs.json` code around you (case-insensitive). They belong to no nest and never respawn; at most 300 may be alive at once. `data.ids`. |
| `item <item code> [n]` | Puts n (1-10,000) of an item into your bag; `ITEM_ETC_GOLD_*` adds n gold. `data.bag` (the changed slots). |
| `kill [id or player]` | Kills a monster (no loot, no EXP) or a player you outrank; without an argument, your current attack target. |
| `skill all [mastery]`, `skill <code> [level]`, `skill sp <n>`, `skill cooldown`, `skill reset` | Your own character only (docs/SKILLS.md §10.1). `all`: every mastery at `mastery` (default `LEVEL_CAP`) and every skill line up to it; `<code>`: one line (a row code such as `SKILL_CH_SWORD_SMASH_A_03` or its group) at `level`, raising its mastery if needed; `sp`: adds SP; `cooldown`: clears your skill cooldowns; `reset`: forgets every mastery and skill. No SP is spent. The client gets `skillsUpdate` (or `skills` after a reset) and `stats`. |

Teleport and summon send `warp {id, pos, yaw}` to everyone who sees the entity, including its own client, which snaps and cancels interpolation.

## Gameplay

The rules follow `docs/PROTOCOL.md`; this is how the server implements them.

**Modules** (`src/`):

| File | What |
|---|---|
| `gamedata.ts` | Loads `OUT_DIR/data/{mobs,nests,items,levels,drops,npcs,shops,towns,zones}.json` at start. Every file is optional and bad records are skipped. The startup log has one line per file (`content mobs.json: 32 loaded`, `... missing (none loaded)`, `... 3 skipped: <problems>`). Without the files the server runs with no monsters or items (tests use `test/fixtures.ts`). |
| `world.ts` | The single simulation: players, monsters, NPCs and ground items, straight-line moves, the tick, and interest management (a uniform grid, recomputed every 200 ms and at once after teleports). |
| `nav.ts` | `NavProvider`: `MeshNav` (the exported @sro/nav terrain + object navmeshes) or `FlatNav` (world bounds, no terrain). See "Navigation". |
| `ai.ts` | The monster AI state machine (idle/wander, aggro, chase, attack, leash/return/regenerate). It is independent of networking and only talks to an `AiHost`. |
| `spawner.ts` | One spawner per enabled nest: `count` alive, and a random `respawnSec` delay after each death. Nests sharing a `uniqueGroup` (unique monsters, e.g. Tiger Girl) hold one mob between them, respawned at a random nest of the group. |
| `formulas.ts` | Every combat and growth number, documented with its source (research report §4.5, client data, or marked as a server rule). |
| `progression.ts` | EXP, level-ups (+1 STR, +1 INT, +3 stat points), SP from SP-EXP, the level cap. |
| `inventory.ts` | Bag and equipment rules as pure functions over a draft; `db.ts` runs them in SQLite transactions. |
| `gameplay.ts` | Requests (`attack` ... `shopSell`), combat, deaths, rewards, loot, regeneration, and the GM gameplay helpers. |

**Monsters.** Nests come from `nests.json` (the vSRO server's Tab_RefNest via the third-party port's data). A nest spawns when all of these hold:
- its `world` is this world;
- its monster is in `mobs.json` and at most `MOB_LEVEL_MAX`;
- it is not `enabled: false`;
- its centre is walkable (inside the world bounds) and in the town spawn's walkable component (reachable on foot from town).

Mobs spawn within `spawnRadius`, wander within `radius`, and roll champion (`championPct`) or giant (`GIANT_PCT`). Aggressive mobs (the nest's tactics) attack players within `sightRange`, and every mob retaliates. A chasing mob gives up past `leashRange` from its nest, runs home and regenerates. While it runs home it evades every hit (`combat` outcome `miss`), so it cannot be kited past its leash and shot down. Mobs farther than the view range + 30 m from every player skip their idle AI. Dead mobs stay 3 s as corpses.

**Combat.** `attack` starts auto-attack. The server walks the player into reach (weapon range + both body radii) and swings at the weapon's cadence (`BASIC_ATTACK` in `formulas.ts` until `skills.json` is wired). Each swing is one `combat` message (sword and blade: 2 hits). Damage uses the §4.5 pipeline: a hit-balance roll inside the attack range, absorb and defence, the level-difference bonus, the STR balance ratio and a minimum damage. Hits can miss (parry), be blocked or be critical. There is no fighting inside a town's safe area (`safe_zone`), and monsters ignore players standing in it. An auto-attack also ends (with a system line) as soon as the attacker stands inside the safe area, so nobody can shoot from town at monsters that cannot hit back.

**Rewards and loot.** EXP and SP-EXP are shared by damage among the players still online (variant multipliers are in `VARIANT_RULES`). Level-ups carry EXP over and stop at `LEVEL_CAP`. Skill points come only from SP-EXP, as in SRO: kill SP-EXP × `SP_RATE` and quest SP (`sp × 400` SP-EXP) add up, every 400 SP-EXP turns into 1 SP at once (`statsDelta {exp, sp, spExp}`, saved with the kill), and a level-up by itself gives none. The drop table is rolled on each kill (gold, then each group). Loot belongs to the top damage dealer's character for 30 s (a relog keeps the priority), then to anyone, and vanishes after 120 s.

**Death.** A player at 0 HP stays dead until `respawn`, which returns it to the town return point with full HP/MP. There is no EXP loss. Out of combat (5 s), HP and MP regenerate 3% every 2 s.

**Inventory.** 48 bag slots and 12 equipment slots, stored in the `items` table: one row per stack, in either a bag slot or an equipment slot, each unique per character. Every request is one SQLite transaction on the character's rows, and the server is a single process, so an item can never be duplicated by concurrent or repeated requests. Potions whose `items.json` entry has no cooldown get a 1 s cooldown per group (`POTION_COOLDOWN_MS`). Return scrolls are a timed cast (`castMs`, 30 / 15 / 5 s), allowed in combat: moving, attacking, talking, a skill or death interrupts it, and the scroll is taken only when the cast completes (docs/SHOPS.md §4.3). New characters get their starter weapon and the default garments for their gender, equipped. This happens once; a character created before `items.json` existed gets them at its next entry.

**Database** (migration 4): `characters` gains `height`, `volume` (0..4, default 2), `outfit` (`clothes`/`light`/`heavy`, default `clothes`) and `nav_surface` (the navmesh surface of the saved position). Existing characters get the defaults.

**Database** (migration 3): `characters` gains `sp, sp_exp, strength, intellect, stat_points, gold, hp, mp, dead, bag_size, starter_kit`, and the new `items` table holds bags and equipment. Existing characters get the level-1 stats plus the growth of their level (STR/INT 19 + level, 3 stat points per level above 1) and their starter kit at the next entry. Positions, HP/MP and the dead flag are saved with the periodic save. EXP, level, stats, gold and items are saved when they change.

## World exports

`WORLD` is the world **id** and `WORLD_EXPORT` the **folder** the server loads (docs/FIELDS.md §4, docs/WAVE_PLAN.md decision 45). The id stays `jangan` for every export: nests, NPCs and towns in `OUT_DIR/data` are stamped `jangan`, saved characters keep `world = 'jangan'`, and all exports share one coordinate frame (origin region 168,97). Switching `WORLD_EXPORT` back and forth is therefore safe: a saved position the smaller export does not cover is moved to the nearest open ground or to the town.

| `WORLD_EXPORT` | Regions | Navmesh | Nests / monsters spawned | Client |
|---|---|---|---|---|
| `jangan` | 3 × 3 (town) | 9 regions, 547 objects | 11 / 160 | loads it whole |
| `jangan-near` | 5 × 5 (166–170 × 95–99) | 25 regions, 715 objects | 100 / 1,236 | loads it whole |
| `jangan-fields` (default when exported) | 307 (156–174 × 90–102) | 307 regions, 2,281 objects (22 MB) | 700 / about 6,080 | streams regions around the player |

```sh
pnpm --filter @sro/server dev                        # jangan-fields when work/out has it
WORLD_EXPORT=jangan pnpm --filter @sro/server dev    # the 3 x 3 town map (loads faster, ~310 MB)
```

- **Startup log**: `navigation: .../jangan-fields/nav.bin (307 regions, 2281 objects, ...)`, `world content: 45 NPCs, 700 nests (125 skipped), 6083 monsters spawned`, and one line for the nests the placement rule refused: `nests not spawned: 91 unreachable on foot from town (861 monsters; regions 156-161 x 98-102: ...)`. Those Western China nests lie across the river; there is no ferry teleport yet, so nobody could walk there. The rest of the skipped count is monsters above `MOB_LEVEL_MAX`.
- **Cost** (`test/fields.test.ts`, a desktop): startup under 1 s; about 750 MB RSS instead of about 310 MB; with 10 idle and 2 fighting players the mean tick is about 1.5 ms (p99 and max about 8 ms).
- **GM places**: `tp` lists the manifest's named places: `jangan` (the town gate), `grassland`, `north-tiger-mt`, `south-tiger-mt`, `bandits-mountain-stronghold`, `lake-forest`, ... `where` and `who` name the area (`in North-Tiger Mt., region ...`), from `OUT_DIR/data/zones.json`, which also gives the character list its location ("Grassland").
- **Respawn** is still the Jangan gate (GATE_CH, the only resurrection point in the area).
- The export must exist in `OUT_DIR/world/` (or `OUT_OPT_DIR/world/`), and the client must be able to fetch it from `/out-opt/world/<WORLD_EXPORT>/` (docs/DEPLOY.md).

## Navigation

The server walks every entity on the world's navmesh (docs/NAVIGATION.md), loaded at start from `OUT_DIR/world/<WORLD_EXPORT>/` + the manifest's `nav.file` (`nav.bin`, SRNV). Without it (or with `NAV=off`) the world is flat inside its bounds, as before.

- **Every entity keeps its surface** (terrain, or one cell of one object instance) with its position. Heights (`y`) always come from that surface and are authoritative: `move.from/to`, `stop`, `warp`, `worldEnter` and `spawn` carry the real ground height (the Jangan plaza is -3.26 m; the terrain hidden under it is -4.79 m).
- **`moveTo`** is one straight walk from the stored position and surface (`@sro/nav` `moveStraight`). It stops at the first blocking edge, with no slide and no path-finding: walls, railings, the fountain rim, the gate piers. The `move` message's `to` is that stop point. The city gate arches pass (the wall walkways above are underpass edges).
- **Monsters** walk the same way: wander points must be open ground with a clear straight walk (a blocked one is dropped for another); chases are straight runs that stop at walls; a mob that cannot walk home is put back at its nest (`warp`, the leash reset). Nest spawns are random points of the spawn circle on open ground (never on closed terrain, never inside or under a house), with the height nearest the nest's `y`; failing that, the open ground nearest the nest centre within its radius.
- **Placements without a surface** use the nearest-height rule (`locate`) on open ground: new characters and respawns land on the town spawn placed with the manifest spawn's height (never a terrain height); a relog restores the saved surface (`nav_surface`) or, without one, the surface nearest the saved height; GM `tp x z` picks the highest open surface (`tp x y z` the one nearest y), `tp <player>` takes the player's own surface, `summon` walks 1 m in front of the GM. A teleport into a wall or a house lands on the nearest open ground within 10 m.
- **Loot** lands on the corpse's surface (a short straight walk from it), NPCs on the surface nearest their npcpos height.
- Positions are clamped 1 cm inside the world bounds (region borders).
- **Performance**: `test/nav-real.test.ts` simulates 5 minutes with the real nests (150 Mangnyang) and 10 players at 20 Hz; the worst tick is about 1 ms. `/health` reports `nav` (`mesh`/`flat`), `mobs` and `worstTickMs` since start.

## Appearance

`charCreate` takes the optional `height`, `volume` (0..4, default 2) and `outfit` (`clothes` | `light` | `heavy`, default `clothes`). They are stored per character. The starter kit is the starter weapon plus the outfit's default set for the gender, equipped: `ITEM_CH_{M|W}_{CLOTHES|LIGHT|HEAVY}_01_{BA,LA,FA}_A_DEF`. `charCreated`/`charList` summaries carry `height`, `volume` and `equip` (visible item codes, so character select can dress the character); player `EntityState`s carry `height`, `volume` and `equip`; equipment changes send `appearance`.

## Static serving

With `SERVE_STATIC` on, `/out-opt/*` (`OUT_OPT_DIR`) and `/out/*` (`OUT_DIR`) are served with:

- MIME types for webp, glb, bin, json, ogg, ttf, png and the rest of `static.ts` `MIME`;
- for text, glTF/bin and fonts (`COMPRESSIBLE`), by `Accept-Encoding`: the precompressed `x.br` sibling (brotli), else `x.gz`, else gzip on the fly (level 6, files of 256 bytes or more), else the file as is. The `Content-Type` is always the original's, each variant has its own ETag (`-br`, `-gz`), `Vary: Accept-Encoding` is set, and a sibling older than its file is ignored. Images and audio are never compressed;
- `Cache-Control: no-cache` with ETag / Last-Modified revalidation (a cheap 304) for the asset trees, whose paths are not content-hashed; content-hashed names (Vite's `/assets/index-BxYz12_a.js`) get a year and `immutable`;
- the same path rules as before: no `..`, no encoded separators, no NUL, no dot-files, no symlinks out of the root.

## Production on Linux (the mini PC)

This setup needs no Docker: one Node process and one SQLite file.

1. Install Node 24 (any recent Node that can run pnpm), then pnpm (`corepack enable` or the standalone installer). pnpm downloads the pinned Node 24.21.0 by itself (`.npmrc`).
2. Clone the repo to `/opt/silkroad` and run `pnpm install`. This builds `better-sqlite3` for Linux, so the build tools are needed (`build-essential python3`) unless a prebuilt binary is available.
3. Build the client: `pnpm --filter @sro/game build`, which writes `apps/game/dist`.
4. Copy the converted assets from the Windows machine. Run the converter (and `optimize-out.ts run --precompress`) there, then e.g. `rsync -a work/out/ minipc:/opt/silkroad/work/out/` and the same for `work/out-opt/`. Retail-derived data never goes into git.
5. Create a service user and a data directory: `useradd -r -m -d /var/lib/silkroad sro`.
6. Install the unit below as `/etc/systemd/system/silkroad.service`, then run `systemctl daemon-reload && systemctl enable --now silkroad`.

```ini
[Unit]
Description=Silkroad web game server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=sro
Group=sro
WorkingDirectory=/opt/silkroad
Environment=NODE_ENV=production
Environment=PORT=7000
# Bind to the Tailscale address only (tailscale ip -4), not to every interface.
Environment=HOST=100.64.0.10
Environment=DATA_DIR=/var/lib/silkroad
Environment=OUT_DIR=/opt/silkroad/work/out
Environment=OUT_OPT_DIR=/opt/silkroad/work/out-opt
Environment=GAME_DIST=/opt/silkroad/apps/game/dist
# Adjust to the output of `command -v pnpm` for the sro user.
ExecStart=/usr/local/bin/pnpm --filter @sro/server start
# SIGTERM makes the server save every position before it exits.
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/silkroad
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Players then open `http://<mini-pc-tailscale-name>:7000/`.

- **Logs**: `journalctl -u silkroad -f`.
- **Backups**: `sqlite3 /var/lib/silkroad/game.db ".backup /var/lib/silkroad/backup-$(date +%F).db"` is safe while the server runs.
- **Updates**: run `git pull && pnpm install && pnpm --filter @sro/game build && systemctl restart silkroad`. Migrations run automatically on start.

### Keep it private: use Tailscale (or another private network)

The server serves assets converted from the retail client (`/out/`), so **do not expose the port to the public internet** and do not port-forward it on the router. Put the mini PC and your friends' machines on a private network such as Tailscale (a tailnet, sharing the machine with friends), WireGuard or ZeroTier. Then bind `HOST` to that interface's address. This also keeps the account API away from internet-wide password guessing.

If you ever add a reverse proxy with TLS in front of it (e.g. Caddy on the tailnet), make it forward WebSocket upgrades on `/ws`, and set `TRUST_PROXY=1` so rate limits see the real client IP.

# Admin panel (`/admin`)

A web panel for the server owner: served by the game server at **`/admin/`**, used from any browser on the tailnet,
nothing to install. It covers the administration that today needs SSH, `pnpm deploy:gm` or in-game GM commands. The
in-game GM console stays as it is; the panel reuses its server logic (the content editors, the uniques module, the
notice broadcast) instead of a second copy.

## 1. Scope

| Page | What it does |
|---|---|
| **Dashboard** | Server info (release, uptime, players online / capacity, world and export, tick health, DB size, registration state, LIVE / LOCAL); live player list with **kick** and **send to town**; a notice box; **Restart** under systemd. |
| **Accounts** | List and search (name, role, banned), **create** (also while registration is closed), reset password, ban / unban with a reason, kick, the account's characters and storage. Roles are shown, never changed (§4). |
| **Characters** | Search; per character: level, EXP, SP, SP-EXP, gold, position (send to town), bag, equipment and the account's storage (give / remove items, `+` level), skills and masteries (read only). Online characters are changed through the gameplay code, so the player sees it at once. |
| **Settings** | Level cap, EXP / SP / gold / drop rates, registration open / closed and the other runtime knobs of `config.ts` that are safe to change. Persisted; applied live where the code allows, else marked *after restart*. |
| **Items** | Browse / search `items.json` with icons; edit an item through `DATA_DIR/content/items.override.json` (never the export). |
| **Drops** | View / edit a monster's drop table through `DATA_DIR/content/drops.override.json`. |
| **NPCs & spawns, Quests** | The GM editors' server logic (`editors/npc-edit.ts`, `nest-edit.ts`, `quest-api.ts`, `live.ts`, `overrides.ts`) with coordinates typed in instead of the GM's position. |
| **Events** | Unique bosses (state, next spawn, spawn now, kill / despawn, timer), broadcast notices, and the scheduled events: *Play the Boss* (docs/PLAY_THE_BOSS.md §6) plugs in through §3.1 as the "Night of the Tiger" sub-page (`pages/boss.ts`): what runs now (the call and its volunteers, the offer, the hunt with her HP and the crowd) with Start a call, Force-pick and Stop; tabs for the weekly schedule (in the server's time zone), the numbers of §6.2 (default, bounds, per-field reset, the server's 422 messages inline, saves carry the rev), the event log with each event's timeline and volunteers in draw order, the lottery blocks and an eligibility check. |
| **Audit log** | Every admin action (who, from where, what, when, before / after, ok) and, on a second tab, the GM command log (`gm_audit`). |
| **Servers** | Server profiles (§2.1): which game server the panel edits. |

Out of scope: changing roles (§4), deleting accounts or characters, editing skills or shops, the World Editor (host
PC only), the Play the Boss gameplay itself (the panel drives its events and numbers, §3.1).

## 2. Architecture

```
browser ──/admin/*──────────────────▶ game server: static files from ADMIN_DIST (apps/admin/dist)
        ──/admin/out/<icon>.png─────▶ game server: converted icons from OUT_DIR, else OUT_OPT_DIR
        ──/api/admin/* (Bearer)─────▶ game server: apps/server/src/admin/api.ts ──▶ the running GameContext
```

- **UI**: `apps/admin`, a Vite app in vanilla TypeScript (no framework, same toolchain as `apps/game`), built with
  `base: '/admin/'` into `apps/admin/dist`. `pnpm admin` runs its dev server on `:5182` (proxy `/api` and `/admin/out`
  to `SRO_SERVER`, default `http://localhost:7000`). Small components in `apps/admin/src/ui.ts` (table with search and
  paging, form and confirm dialogs, suggestion lists with icons, toasts).
- **Server**: `apps/server/src/admin/`: `store.ts` (the admin tables), `settings.ts` (the settings registry,
  persistence, live application), `content.ts` (item and drop override layers), `icons.ts`, `routes.ts` (route groups
  and events of other modules), `api.ts` (the router: auth, rate limits, validation, audit) calling `accounts.ts`,
  `characters.ts`, `world.ts` and the existing modules.
- **Shared types**: `packages/shared/src/admin.ts`.
- `game.ts` hooks: the admin store and saved settings at start (before anything reads the config), the item / drop
  layers after the GM layers, the registration and ban checks in `/api/register` and `/api/login`, the `/api/admin/`
  route, the `/admin/` files and icons, the merged `items.json`.

**Icons.** Item icons come from the icon export (`OUT_DIR/icons/index.json`, as the game HUD reads them), else
`ItemDef.icon`; only files that exist in `OUT_DIR` or `OUT_OPT_DIR` are listed, as `/admin/out/<path>`, which the
server serves from either tree (only `icon/`, `icons/` and the target window's rank icons; 404 for anything else).
Retail has **no per-monster portrait**: monsters show their rank's target window icon (`tw_icon_normal`, `_unique`,
...). Images are 24-32 px, lazy-loaded, with a lettered tile when missing.

### 2.1 Server profiles (which server the panel edits)

Every call goes to the **active profile's** server with **that server's** session token:

- A profile is a name and a server URL (http(s) origin). "This server" (the one that served the page) is always there;
  others are added on the Servers page. Profiles are kept in the browser's localStorage (no secrets). Sessions are per
  server and per tab (sessionStorage); passwords are never stored. The active profile is per tab.
- The top bar always shows the target in its connection chip: name and **LIVE** (red, plus a red line along the top
  of the page) or **LOCAL** (green), the URL on hover; the sidebar (the drawer on phones, where the chip shrinks to the
  LIVE / LOCAL badge) shows the name and URL. `GET /api/admin/info`
  (no session) tells each server's name, world, release and environment: `local` when it listens on a loopback
  address only (a development server), `live` otherwise. The Servers page and the login check every profile and show
  "unreachable" or "no admin API (an older server)".
- Destructive dialogs (ban, kick, remove, revert, restart, kill) name the target server; on a LIVE server (or one whose
  state is unknown) the admin must type the server's name to confirm.
- Another server answers the panel only if this page's origin is in its `ALLOWED_ORIGINS` (the existing origin list;
  the dev origins `http://localhost:5180-5182` are always in it). For those origins the admin API answers CORS for
  Bearer requests (no cookies, no credentials). Example: to edit the live mini PC from the panel of a local server on
  `http://localhost:7000`, add `ALLOWED_ORIGINS=http://localhost:7000` to `~/silkroad/silkroad.local.env` on the mini
  PC and restart it; the development panel (`pnpm admin`, `:5182`) needs nothing. The role check on the target server
  stays the security boundary.

## 3. Endpoints

All under `/api/admin/`, JSON in and out, `Authorization: Bearer <admin token>` on everything but `info` and `login`.
Errors are `ApiError {error, message}` like the rest of the API (400 bad input, 401 no / expired session, 403 not an
admin, 404, 409 conflict, 413 body too big, 422 content that does not validate (with `issues`), 429 rate limited).

| Method and path | Body / query | Result |
|---|---|---|
| `GET info` | (no session) | `AdminInfo` |
| `POST login` | `{username, password}` | `{token, expiresAt, account}` |
| `POST logout`, `GET me` | | 204, `{account, expiresAt}` |
| `GET dashboard` | | `AdminDashboard` (server info, players, lobby) |
| `POST players/:characterId/kick` / `town` | `{reason?}` / – | |
| `POST notice` | `{text}` | `{recipients}` |
| `POST restart` | | 202, then the process exits with 75 (systemd starts it again) |
| `GET accounts` | `?q=&role=&banned=&page=&size=` | `AdminPage<AdminAccountRow>` |
| `POST accounts` | `{username, password}` | `AdminAccountDetail` (a player) |
| `GET accounts/:id` | | `AdminAccountDetail` (characters, storage) |
| `POST accounts/:id/password` / `ban` / `unban` / `kick` | `{password}` / `{reason}` / – / `{reason?}` | |
| `POST accounts/:id/storage` / `storage/remove` / `storage/gold` | `{code, count, plus?}` / `{slot, count?}` / `{gold}` | `AdminStorage` |
| `GET characters` / `GET characters/:id` | `?q=&online=1&page=&size=` | |
| `POST characters/:id/progress` / `gold` / `town` | `{level?, exp?, sp?, spExp?}` / `{gold}` / – | `AdminCharacterDetail` |
| `POST characters/:id/items` / `items/remove` | `{code, count, plus?}` / `{where: 'bag'\|'equip', slot, count?}` | |
| `GET settings` / `PUT settings` | `{values: {key: value \| null}}` (null = back to the env / default) | `AdminSettingsView` |
| `GET items`, `GET/PUT/DELETE items/:code` | `?q=&category=&overridden=1`; `{patch, baseRev?}` | |
| `GET drops`, `GET/PUT/DELETE drops/:mob` | `?q=&overridden=1`; `{table}` | |
| `GET mobs`, `GET shops` | `?q=` | pickers |
| `GET nests`, `POST nests`, `POST nests/:id`, `POST nests/:id/{move,remove,restore}`, `POST nests/undo` | | the nest editor |
| `GET npcs`, `POST npcs`, `POST npcs/:code`, `POST npcs/:code/{move,remove,restore}`, `POST npcs/undo` | | the NPC editor |
| `GET quests`, `GET quests/:id`, `PUT quests/:id`, `POST quests/:id/{disable,enable}`, `DELETE quests/:id` | | the quest editor (as the admin; it also writes its `gm_audit` rows) |
| `GET uniques`, `POST uniques/:code/{spawn,kill,despawn,timer}` | `{camp?}`, `{minutes \| 'now' \| 'clear'}` | |
| `GET events` | | `{events: AdminEventInfo[]}` |
| `GET audit`, `GET gm-audit` | `?q=&action=&page=` | |

### 3.1 Extension points (Play the Boss)

`admin/routes.ts`:

- `registerAdminRouteGroup({prefix, maxBody?, handle(ctx, req)})` mounts a module under `/api/admin/<prefix>/*`. The
  panel's router keeps the login, the admin role and ban check, the rate limit and the body limit, then calls
  `handle` with `{method, path, query, body (parsed JSON), actor: {accountId, role, username}}` and answers its
  `{status, body}`. It adds one `admin_audit` row per write (`<prefix>.<method>`, the path, the body, `HTTP <status>`)
  on top of whatever the module audits itself. Built-in prefixes cannot be taken.
- `registerAdminEvent({id, info(ctx)})` lists a scheduled event on the Events page (`AdminEventInfo`: state, next
  start, settings, log, `routes`). In the panel, `EVENT_PAGES` (`apps/admin/src/pages/events.ts`) maps a route group to
  its sub-page, shown under the event's card.

Play the Boss uses it as written (docs/PLAY_THE_BOSS.md §6.3, `apps/server/src/pilot/admin.ts`):
`registerAdminRouteGroup({prefix: 'boss', handle: routeAdminBoss})` and `EVENT_PAGES.set('boss', bossPage)`. Its routes:
GET `boss` (status, schedule, settings), PUT `boss/settings` `{code?, baseRev, patch}` (409 stale rev, 422 `{issues}`),
POST `boss/settings/reset` `{paths?}`, POST `boss/start` `{callMinutes?}`, `boss/pick` `{character}`, `boss/stop`, GET
`boss/events[/:id]`, GET `boss/blocks`, PUT / DELETE `boss/blocks/:account` `{days, reason}`, GET
`boss/eligibility?character=`. The handler re-checks the admin role and writes a `gm_audit` row (command `pilot`) per
write, so the GM commands (`/unique pilot ...`) and the panel share one trail. The settings live in `pilot_settings`
(migration 14) as a patch over content/uniques.json's defaults.

## 4. Security model

- **Who**: only accounts whose role is `admin`. The role (and the ban) is re-read from the database on **every**
  request, so `pnpm gm revoke` locks the next request out. No endpoint trusts the UI.
- **Roles never change here.** The owner-only role policy (`apps/server/test/role-policy.test.ts`) keeps every role
  change in the server-side CLI (`pnpm gm grant / revoke`, `pnpm deploy:gm ...`); the panel shows roles and the command.
- **Sessions**: separate from game sessions (`admin_sessions`), so a game token never opens the panel. A random
  32-byte token, stored as its SHA-256; 12 h lifetime, 2 h idle timeout, at most 5 per account; sent as
  `Authorization: Bearer` (no cookies, hence no CSRF). The UI keeps it in `sessionStorage` per server (gone with the tab).
- **Login**: scrypt verification as `auth.ts` (constant time, the same dummy-hash work for unknown users), counted
  before the hash: 5 failures per IP + name and 20 per IP per 15 minutes, then 429. A correct password on a
  non-admin or banned account is refused (403) and counted. Every login, success or not, is audited.
- **Origin**: `/api/*`'s rule (`origin.ts`: no Origin, the server's own origin, or a listed one). CORS answers only
  listed origins (§2.1); everything else gets no CORS headers, and its `OPTIONS` a 404.
- **Rate limits**: 20 requests/s per admin account (burst 60) on top of the login limits; bodies at most 4 KB (32 KB
  for item, drop, quest and route-group bodies).
- **Validation**: every body is checked field by field (unknown keys refused, numbers bounded, codes matched against
  the loaded content, names and passwords by the game's rules); no endpoint runs code, SQL, a shell or a GM command
  line typed by the user; the editors receive parsed, re-checked arguments only.
- **Self-lockout**: an admin cannot ban or kick themselves.
- **Static files**: `/admin/` has a CSP with scripts and styles from the page's own origin only (no inline),
  `frame-ancestors 'none'`; `connect-src` and `img-src` also allow http(s) for the server profiles. `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`; API answers are `no-store`.
- `ADMIN_PANEL=off` turns the panel, its icons and its API off (404).

## 5. Where the data lives (and what survives a deploy)

Every write lands in **the data of the server that receives the request**: its `game.db` and its `DATA_DIR`. On the
mini PC that is `~/silkroad-data` (`DATA_DIR`, docs/DEPLOY.md), which a deploy never replaces; the release folder
(`~/silkroad/releases/<release>`, holding `content/` and the code) is replaced on every deploy and is **only read**.
Nothing the panel or the in-game editors do writes the repo's `content/` folder.

Layers, lowest first:

| Layer | Where | Written by |
|---|---|---|
| The converted export | `OUT_DIR/data/*.json` (`~/silkroad-assets/out`) | the converter, synced by the deploy |
| Shipped content and repo overrides | `CONTENT_DIR` = the release's `content/` (`quests/`, `uniques.json`, `{nests,npcs}.override.json`, `places.json`) | git, shipped with each release |
| Runtime overrides | `DATA_DIR/content/`: `nests.override.json`, `npcs.override.json`, `quests/*.json` (the GM editors and the panel), `items.override.json`, `drops.override.json` (the panel), `history/` (every previous version) | the running server |
| Runtime settings | `game.db` `admin_settings` (over the environment: `silkroad.env`, then `silkroad.local.env`) | the panel |
| Accounts, characters, bans, sessions, audit | `game.db` | the server |

**Admin tables** sit in `game.db` (so the deploy's database snapshot includes them) but outside the numbered gameplay
migrations: `admin/store.ts` creates `admin_sessions`, `admin_audit`, `admin_settings` and `account_bans` with
`CREATE TABLE IF NOT EXISTS` and keeps its own version in `admin_meta` (append-only, like `MIGRATIONS`). They are new
tables only (no `ALTER` of gameplay tables), so the numbered migrations stay with their lanes and an older server
ignores them.

**Settings** precedence: built-in default < environment < panel. Resetting a setting in the panel deletes its row, so
the environment value applies again. At start `game.ts` applies the saved values to the config before any module reads
it; a saved value that no longer validates is skipped with a log line, never fatal. If the panel saves a level cap and
`MOB_LEVEL_MAX` was not set on its own, the monster level limit follows (cap + 5) at the next start.

**Item and drop overrides** use the GM editors' file conventions (atomic write, a history copy per change, `rev`):
`{schema: 1, kind: 'items-override', rev, updatedAt, patch: [{code, ...fields}]}` (name, prices, required level,
stack, degree, fees, flags, stat ranges, use effects) and `{schema: 1, kind: 'drops-override', rev, updatedAt,
tables: [DropTable]}` (a table replaces the monster's exported one; known items only). Layered at start and on every
save; DELETE restores the export. A bad record is skipped with a log line.

## 6. Live or after a restart

| Setting | Env | Applies |
|---|---|---|
| Registration open | `REGISTRATION` | live (the login screen asks the server each time it opens) |
| Capacity | `CAPACITY` | live |
| Level cap | `LEVEL_CAP` | live for EXP, shops, quests and `setlevel`; players see it after re-entering the world; unique gear pools and the default monster level limit at the next restart |
| EXP / SP / gold / drop rates | `EXP_RATE`, `SP_RATE`, `GOLD_RATE`, `DROP_RATE` | live |
| Giant chance, quest reset hour, quest EXP at the cap, bow ammo, storage fee | | live |
| Combat, durability, alchemy, Berserk, guild and stall knobs | `MOB_*`, `DUR_*`, `ALCHEMY_*`, ... | live (alchemy and guild numbers shown in the client update after re-entering the world) |
| View range | `VIEW_RANGE` | live |
| Registrations per IP per hour | `REGISTER_LIMIT` | after restart |
| Monsters on, monster level max, nest count scale, uniques on, move speed | `SPAWN_MOBS`, `MOB_LEVEL_MAX`, `NEST_COUNT_SCALE`, `UNIQUES`, `MOVE_SPEED` | after restart |

Never in the panel (environment only): ports, addresses, folders, the world and its export, origins, proxy trust,
navigation, tick rate, save interval, `EDITOR_ROLE`.

Item overrides apply live to the server (worn copies are recomputed for online players, shop lists rebuilt); in
production the server serves `/out/data/items.json` merged with them, so the client shows the same names, prices and
stats after a reload. Drop overrides apply to the next kill. NPC, nest and quest edits apply live as their GM
commands do.

**Restart**: offered only when the server runs as the systemd service (`INVOCATION_ID` is set). The server saves and
closes like on SIGTERM, then exits with code 75; the unit's `Restart=on-failure` starts it again 5 s later. In
development (no supervisor) the button is hidden and the panel says to restart by hand.

## 7. Deploy

- `deploy/remote/install.sh prepare` also builds `@sro/admin` (a failure is a warning: the game still deploys), and
  `silkroad.env` gets `ADMIN_DIST=$APP/current/apps/admin/dist`. The deploy's health check reports `/admin/`.
- The admin tables are in `game.db` and the override files in `DATA_DIR/content/`: both survive deploys, and the
  activation snapshot covers the tables.
- Making an account admin: `pnpm deploy:gm grant <name> --role admin` (or `pnpm gm grant <name> --role admin` on the
  host). The panel is then at `http://<host>:7000/admin/`. See docs/PLAYTEST.md "Admin panel".

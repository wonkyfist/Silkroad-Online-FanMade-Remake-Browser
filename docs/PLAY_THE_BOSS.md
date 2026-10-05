# Play the Boss: a player steers Tiger Girl, everyone else hunts her

**Status (2026-10-05): layers 1–5 built** (see the two Build paragraphs below; the 100-player perf gate of layer 5 is
still open). The design text below was written at HEAD `7fccbfc` and is kept as the spec. Mockup: Dropbox `play-the-boss/play-the-boss-preview.png` (the HUD,
banners and dialogs below follow it).

**Build (layers 1–3).** Server: `apps/server/src/pilot/` (service, steer, kit, hunt, store, gm, admin), the seams of
§3.1 (no `hold` yet: it belongs to the call), `content/uniques.json` `pilot`, `packages/shared/src/pilot.ts`. Changes
from the text below: the migrations are **12** (§5.3) and **13** (`pilot_honors`, moved up from §5.4 for layer 3's
title); the same-IP associate rule never counts a loopback address (a dev server's own PC, tests); a kit row or pack
mob missing from a world's tables leaves that ability out (logged) instead of failing the start; `attach` keeps her
camp as the circle's centre and widens her leash to the circle for the session (restored on detach).

**Build (layers 4–5, 2026-10-05).** All five layers are built. Layer 4: `pilot/call.ts` (the call, volunteers, the
draw, the weekly schedule, restarts, blocks), `pilot/lottery.ts` (eligibility, the weighted draw, the schedule's
time-zone maths; pure), `pilot/settings.ts` (the settings patch), `pilot/admin.ts` (every §6.3 route), `pilot/gm.ts`
(`start`, `block`, `unblock`), `Uniques.hold`, **migration 14** (`pilot_settings`, `pilot_volunteers`,
`pilot_blocks`; `pilot_honors` was 13), the client's call banner (`hud/pilot-hud.ts CallBanner`,
`world/features/pilot.ts`), the panel page (`apps/admin/src/pages/boss.ts`). Layer 5: `pilot/scale.ts` and the shared
formula (`pilotScaleFactor`, `pilotScaledMaxHp`, `pilotNextMaxHp`, `pilotKeepFraction`, `pilotScaledSummons` in
`packages/shared/src/pilot.ts`), `Uniques.summonPolicy` asks `pilotScale`. Tests: `apps/server/test/pilot-{lottery,
call,admin,scale}.test.ts`, additions to `pilot-e2e`, `pilot-event`, `packages/shared/test/pilot.test.ts`,
`apps/game/test/pilot.test.ts`. Choices made while building (each also noted in its section):

- **Time zone**: the schedule uses the server process's zone (the user's decision). `schedule.tz` stays in the
  settings schema and the API (validated: '' or an IANA zone this runtime knows) but the panel does not offer it.
- **Settings apply at once**: a running event keeps its timers (call end, hunt end, circle); every other number is
  read live. A stored patch is pruned to what differs from the content defaults; a stored value that later breaks a
  bound is dropped at load (logged). Cross-field rules: the two level fields ≤ the server's level cap,
  `capHunters` ≥ `baseHunters`.
- **A cancel refunds the turn** too (§2.3 says so; layer 3 only refunded a restart): `refunded = 1` for `cancelled`.
- **Force-pick during a call** closes the call and does not count as a draw; if that player declines, the draw goes
  on from the volunteers. A force-pick without a call still ends `no_volunteers` on a decline (layer 3).
- **`busy`** = in a trance (steering), in a trade, or with a stall open. A second character of an account that
  volunteered already is refused `not_eligible` with a message (no new `PilotIneligible` value; the wire is unchanged).
- **No volunteers after a call**: she spawns now as her normal AI self (announced) when she is not alive, whatever her
  own timer said; alive she stays as she is.
- **Play time** for eligibility is the saved `played_ms` (at most one save interval behind).
- **Restarts**: only a call or a draw resumes; a GM pick's open offer still ends `restart`. Of the nights missed by
  more than 30 min, the newest is logged (server log; no event row exists for it).
- **The call's chat lines** (open, 5 min, 1 min) are drawn by the client from `huntEvent` (i18n `pilot.call.chat`,
  `pilot.call.soon`); the server sends no chat for them.
- **Scaling**: N counts characters, and only damage to her (not her summons); the base is her max HP at the hunt start
  (47,898); the steps run every 5 s from the hunt start. 10 hunters give 109,261 HP (the table below rounds).
- **Admin routes** run on the game clock (`Gameplay.now`: the last tick or request), like the GM commands.

**Left out of this build (still open):** serializing each broadcast once (`World.broadcastAbout` still stringifies
per socket), the load runs of §7 (`pilot-load.ts` with 20 / 50 / 100 bot hunters) and the CHAR_PERF crowd tier that
gates 100 players; `CAPACITY` stays 50. The `soak-host.ts` graceful-restart runs of §7 (the restart rules are tested
in-process instead), a separate `abuse-pilot.test.ts` file (its layer-4 cases live in `pilot-call.test.ts`), the
Wardrobe cosmetic (none exists), Stalk's grass mask (§9 Q4).

**The user's decisions (not re-opened here).** Who: a volunteer lottery during a 10-minute call (level 20, minimum play
time, no blocks, not a recent pilot, first-timers weighted up); one is drawn, has 30 s to accept, else the next; no
volunteers = the normal AI Tiger Girl; a GM can force-pick. When: a weekly "Night of the Tiger" set in the admin tool,
plus GM start/stop. Win: she survives a timer (15 min) or downs N hunters (15); hunters win by killing her. All numbers
editable in the admin tool.

**Tags.** **[confirmed]**: read in the code or data; the text names the file and function. **[decision]**: a choice
this spec makes, with its reason. **[unknown]**: open; the default used is given. **[projected]**: computed from
measured or confirmed numbers, not measured on that setup.

**Sources read.** docs/UNIQUES.md, PROTOCOL.md, BALANCE.md, CONVENTIONS.md, CHAR_PERF.md, WARDROBE.md (cosmetics),
MOVEMENT.md §13 (WASD). Code: `apps/server/src/{uniques,ai,mob-skills,movement,gameplay,modules,world,party,gm,db,
connection,config,formulas,mounts}.ts`, `social/{trade,stall,guild}.ts`, `skills/engine.ts`, `editors/{overrides,
live,quest-api}.ts`, `test/soak/*`; `packages/shared/src/{protocol,content}.ts`; `apps/game/src/{screens/world.ts,
world/features.ts, world/features/{keymove,skills}.ts, world/skills-view.ts, world/ride-mob.ts, hud/{keys,hotbar,
unique-notice}.ts, i18n/en-unique.ts}`, `packages/world-render/src/grass/bake.ts`. Data: `work/out/data/{mobs,skills,
nests,towns,cos}.json`, `content/{uniques,places}.json`.

---

## 0. Summary

1. **The boss stays a monster entity.** A player's input drives the existing Tiger Girl mob through the same server
   paths the AI uses (`World.moveEntity`, `MobSkills.use`). No player-vs-player code: hunters attack a mob, she hits
   players with mob skills. Notices, loot, summons, enrage and the server's checks keep working unchanged.
2. **One new server module** `apps/server/src/pilot/` (a GameplayModule after `uniques`) owns the event, the lottery,
   the pilot link, the kit, the hunt signals and the rewards. Elsewhere only small, named seams (§3.1, §4.1).
3. **Movement reuses `moveTo`.** The client's WASD and click-to-move already send `moveTo`; the server redirects the
   pilot's `moveTo` to the mob, picks the speed, clamps to the hunt area and walks the navmesh as for any move.
4. **The pilot's view moves to the mob.** Interest management today centres on the player's own position; a
   `Player.viewFrom` seam centres it on her. The client gets a "controlled entity" seam (camera, streaming, minimap,
   KeyMover follow it).
5. **AI fallback.** Idle 20 s, disconnect or quit: `thinkMob` steers her again, with her home moved to the hunt centre
   and the leash widened to the hunt area. During the event she never regenerates, never refills at home, never
   resets, and her 10-minute fury is off (the survival timer replaces it).
6. **Kit**: her 3 retail rows plus Pounce, Fear Roar, Call the Pack, Stalk, defined in `content/uniques.json`
   (a new `pilot` block) and built from existing pieces (nav walks, `knockback`/`knockdown`, `createMob`, interest).
7. **Stalk cannot check grass yet**: the server has no grass data. Layer 2 ships Stalk anywhere outside towns, at
   reduced speed; "only in tall grass" needs a converter cover mask (§9 Q4).
8. **Scaling (layer 5)**: max HP = 47,898 × (clamp(N, 4, 40) / 4)^0.9, N = hunters who really hit her in the last
   60 s; HP keeps its percentage. Summons scale with √ of that factor.
9. **Guards**: associates (party, guild, same account, same IP; there is no friends list) are stripped from her damage
   map before the kill is shared; all free chat is blocked for the pilot; every input is validated server-side.
10. **Rewards**: gold by performance (≈ 6,000–25,000), a title on a win, a cosmetic once Wardrobe dyes exist. Never gear.
11. **Settings**: the kit and the default numbers are content (`content/uniques.json`); the schedule and the live
    numbers are a DB patch (`pilot_settings`) the admin panel edits through a small service contract (§6).
12. **Two migrations**: layer 1 (events, log, a play-time counter that starts accruing early), layer 4 (settings,
    volunteers, blocks, titles).
13. **Effort ≈ 40 agent-days** over 5 layers. The user and friends can play from layer 3 (≈ 25 agent-days in).

---

## 1. Today [confirmed unless tagged]

| Fact | Where |
|---|---|
| Tiger Girl is run by `Uniques` (GameplayModule `uniques`): 11 camps re-read from nests per roll, timers in the `uniques` table (migration 10), `uniqueNotice` appear/defeat, her own drop table, enrage at 20 % and fury after 600 s through `Mob.damageMul`, summons through `summonPolicy`, corpse 8 s | `uniques.ts` header, `behave`, `ended`, `spawn` |
| Her numbers: level 20, HP 598,720 × `hpMul` 0.08 = **47,898**, run **9 m/s**, walk 2, radius 2.8, attack range 2.8, interval 3,000 ms | `work/out/data/mobs.json`, `content/uniques.json` |
| Rows: ATTACK01 melee 2 hits, cast 1,109 + action 1,391, cd 3,000, weight 100; ATTACK02 300 %, 4 m caster area ≤ 5 targets, action 4,000, cd 4,500, weight 30; ATTACK03 15 m magic 367 % + `zombie`, cast 3,003, cd 5,500, weight 10; SUMMON01–03 bands 80/60/40 %, SUMMON04 `aiChance` 0 (off) | `work/out/data/skills.json` |
| Every mob swing goes through `MobSkills.use(m, row, target, now)` (public): cooldown, busy window, `cast`, release with reach slack, areas, projectiles, statuses, `Gameplay.dealHits`. Its per-mob state (`ready`, `summoned`) is private | `mob-skills.ts` |
| The AI: `thinkMob` idle/chase/return; leash measured from `m.home`; `goHome` clears `m.damage`; `arriveHome` → `Gameplay.restored` refills HP and calls `Uniques.homeReached` (a reset) | `ai.ts`, `gameplay.ts restored` |
| `Gameplay.tick` skips held/busy mobs, lets idle mobs far from every player go dormant, else runs `thinkMob`; `regenMob` gives **5 % max HP every 2 s** after 5 s out of combat: a hiding boss is full in 40 s | `gameplay.ts tick`, `formulas.ts REGEN` |
| `Uniques.behave` drops attackers farther than `leashRange + 40` m from `m.home` from her damage map | `uniques.ts behave` |
| Players can only attack mobs: `attackRequest` answers `invalid_target 'no PvP'` | `gameplay.ts attackRequest`, PROTOCOL.md |
| Mobs never target the dead, invisible GMs or anyone in a town safe area | `gameplay.ts attackable` |
| The town safe area (JANGAN) is ≈ 1,030 m from the nearest camp (5906) and the town spawn ≈ 1,320 m [computed from `towns.json` `safeArea` and `nests.json`] | data |
| `moveTo` → `Gameplay.onMoveTo` (gates; no x/z) → `World.moveTo`: a straight navmesh walk from the live point at `MOVE_SPEED` 5.5 m/s, clipped at the first blocking edge | `connection.ts`, `world.ts walkEntity`, `config.ts` |
| No gate refuses `moveTo` for a stunned player; only the mount, stall, trade and alchemy gates look at it | `grep "'moveTo'"` over `apps/server/src` |
| Horses run 9.9 m/s (×1.8) and riders cannot attack | `mounts.ts` header, `cos.json` |
| Interest: a player receives entities within 120 m (+10 m to drop) of **its own** position | `world.ts inRange`, `updateInterest` |
| Warping a player with `Gameplay.warped(p, 'gm')` ends a trade, a stall, alchemy, item casts and NPC dialogs; a ridden horse follows | `trade.ts`, `stall.ts`, `alchemy.ts`, `item-use.ts`, `mounts.ts` `warped` |
| Local chat goes to the whole world | `connection.ts` `case 'chat'` → `World.broadcast` |
| Module hooks: `playerDied(p, now)` carries no killer; `Gameplay.mobDied` builds shares from `m.damage` (`party.killShares ?? soloShares`), then loot, then the `mobDied` hook with the loot owner | `modules.ts`, `gameplay.ts mobDied` |
| Client WASD: `KeyMover` sends `moveTo` (lookahead 1 s, keep-alive 250 ms, ≤ 10/s), predicts **the own view** (`ctx.selfId()`), speed = its latest `move` | `world/features/keymove.ts` |
| The camera, ground streaming, world update and minimap follow `selfView()` | `screens/world.ts` frame loop |
| Hotbar keys 1–0 are `hotbar.N` bindings; a later binding wins, two bindings that both declare `when` share a key without a warning | `features/skills.ts`, `hud/keys.ts register` |
| A `cast` with a code the client cannot resolve (`catalog` or `fallbackDef` → mobs.json attacks) plays no clip | `world/skills-view.ts cast` |
| She is drawn as the ridden composite (rider leads, tiger is the companion) | `world/ride-mob.ts` |
| GM: the `unique` row of `COMMANDS` calls `Uniques.gm`; every command is audited in `gm_audit` | `gm.ts`, `uniques.ts gm` |
| Storage: append-only migrations, 10 today; content JSON in `content/` with GM overrides in `DATA_DIR/content/` (atomic write, history); env knobs read once | `db.ts`, `editors/overrides.ts`, `config.ts` |
| HTTP: `game.ts api()`; the GM editor routes `/api/gm/*` take a Bearer token and re-read the role per call | `editors/quest-api.ts` |
| **Missing**: no ban or report system, no friends list, no play-time counter (only `characters.last_played`), no character titles (only guild titles), no server-side grass (the client bakes grass from terrain tiles) | greps; `world-render/src/grass/bake.ts` |
| Scale: `CAPACITY` 50, `TICK_HZ` 10; `Connection.send` JSON-stringifies once per recipient; 20 players at one fight sit near the 60 fps line on WebGPU Medium (27.6 ms p95 today, 15.0 with the CHAR_PERF crowd prototype) | `config.ts`, `connection.ts`, CHAR_PERF.md |
| Bots: `test/soak/soak.ts` + `soak-host.ts` drive WebSocket bots against the real server | `apps/server/test/soak/` |

---

## 2. The event flow

### 2.1 States

```
          schedule (call opens) | GM / admin start
  idle ─────────────────────────────────────────► call ── callEndsAt ──► draw ──► offer ── accept ──► hunt ──► ended
   ▲      GM / admin pick (no call) ──────────────────────────────────────────────►│                 │
   │                                                                ▲  decline/30 s │                 │
   │                                                                └── next ───────┘ (≤ maxDraws)    │
   └──── ended: killed | survived | downs | no_volunteers | cancelled | restart ◄─────────────────────┘
```

`hunt` has two flags for the HUD only: **fight** (damage to or from her in the last 10 s) and **steering**
(`player` or `ai`). The module's tick drives every transition; each one writes the event row and a `pilot_log` line.

### 2.2 Phases

| Phase | Starts / lasts | Server | Everyone in the world sees | The drawn player / pilot sees | Persisted |
|---|---|---|---|---|---|
| idle | – | next night from the settings | – | – | settings |
| call | slot time − `call.minutes` (10), or a GM/admin start; lasts 10 min | holds her spawn timer past the hunt start (`Uniques.hold`); records volunteers | top banner "The tiger spirit stirs… who will become Tiger Girl?", countdown, volunteer count; eligible players get **Volunteer / Not this time**, others the reason; chat line at open, 5 min and 1 min | – | `pilot_events` (phase, `call_ends_at`), `pilot_volunteers` |
| draw → offer | at `callEndsAt`; 30 s per offer, ≤ `maxDraws` 5 | weighted draw (§3.9); skips volunteers offline, dead or no longer eligible | "Drawing a volunteer…" | dialog: rules + "Accept within 0:27" | `pilot_volunteers.draw` (offered, declined, timeout, skipped:why) |
| hunt | on accept; `surviveMin` 15 | trance warp; she spawns at a random camp, or is taken over where she stands if alive (HP and fight kept); link, area, timers | today's "Tiger Girl has appeared! Area: …" (if spawned), then the hunt banner: "Tiger Girl was sighted! Area: …", next sighting, she wins in, hunters; area pings, footprints, roars; down lines in chat | control, HUD, kit, taunt wheel | phase, `hunt_started_at`, `hunt_ends_at`, pilot ids, camp; downs and `steered_ms` each minute |
| ended | on an outcome | rewards, flags, her exit (§2.3), her normal 3–6 h timer | result banner (NoticeBanner queue) + chat line; the pilot is named only now | result window: outcome, downs, time, gold | outcome, `ended_at`, stats, reward |

[decision] Taking her over when she is already alive keeps a party's fight (and its damage share) instead of
deleting it; the call banner warns 10 min ahead. [decision] The pilot stays anonymous until the end (no harassment
during the hunt, no "go easy on me" whispers).

### 2.3 How it ends

| Outcome | Trigger | Her | Hunters | Pilot |
|---|---|---|---|---|
| killed | HP 0 | today's kill path: EXP, loot to the top non-associate group, `uniqueNotice defeated`, Berserk | win | performance gold, no win bonus |
| survived | `now ≥ huntEndsAt` (AI time counts) | roars (FIND clip), despawns 8 s later, silent `Uniques.endEvent` → 3–6 h timer | nothing | win: gold + bonus + title |
| downs | downs ≥ `downsTarget` | as survived | nothing | as survived |
| (pilot left) | quit or disconnect: a flag, not an outcome | the AI steers her to the natural end | as the outcome | forfeits the reward; the turn counts |
| cancelled | GM/admin stop | silent despawn, 3–6 h timer | – | no reward, turn refunded |
| no_volunteers | nobody accepted | her normal AI spawn at the hunt start, today's rules | – | – |
| restart | server restart in the hunt | §2.4 | – | turn refunded |

### 2.4 Restarts

| Phase at shutdown | At boot |
|---|---|
| call | resume if `call_ends_at ≥ boot + 2 min`, else `call_ends_at = boot + 3 min` (people need time to log back in); volunteers kept |
| draw / offer | back to draw at boot + 3 min; offers are not persisted, a decline stays a decline |
| hunt | outcome `restart`, turn refunded. Her `uniques` row is `alive`, so today's rule brings the AI boss back 1–2 min after boot at a new camp, full HP [confirmed `Uniques.restart`]. The pilot's body was saved at the shrine, in town |
| a slot's call start passed during the downtime | if boot is within 30 min of it: open the call now with the time left (≥ 3 min); else skip and log |

### 2.5 GM and admin controls

`/unique pilot …` (a sub-command of the existing `unique` row, so it is audited like every GM command):

| Command | Does |
|---|---|
| `pilot <name>` (alias `pilot pick <name>`) | force-pick: offers the turn to `<name>` now (eligibility skipped, consent still asked); during a call it closes the call |
| `pilot start [callMinutes]` | opens a call now (1–60 min, default the setting) |
| `pilot stop` | cancels the current event at any phase |
| `pilot status` | phase, timers, pilot, steering, downs, hunters, her HP |
| `pilot attach <name>` / `detach` | layer 1 test tool: steer the living Tiger Girl with no event rules |
| `pilot block <name> <days> [reason]` / `unblock <name>` | layer 4: lottery blocks |

The words start, stop, status, attach, detach, block, unblock and pick are reserved; a character with such a name is
picked with `pilot pick <name>`. The admin panel calls the same service (§6).

---

## 3. Server design

### 3.1 Module and seams

`apps/server/src/pilot/`: `service.ts` (the GameplayModule `pilot`, state machine), `steer.ts` (link, input, AI
handover), `kit.ts` (abilities), `hunt.ts` (area, pings, trail, roars, downs, scaling), `lottery.ts` (eligibility,
draw, schedule; pure functions), `store.ts` (SQL), `admin.ts` (§6), `gm.ts`. Registered after `uniques`, only when
UNIQUES=on and the unique has a `pilot` block. `handles`: `pilotVolunteer`, `pilotAnswer`, `pilotAct`, `pilotTaunt`,
`pilotQuit`. Hooks: `enter` (late joiners get `huntEvent`), `tick`, `playerDied`, `mobDied`, `forget`, `gate`.

| File | Seam | Why |
|---|---|---|
| `world.ts` | `Mob.pilot?: { player: number \| null; steering: 'player' \| 'ai' }`, `Mob.veil?: number`, `Player.viewFrom?: number`, `Player.trance?: true`; `inRange` and `updateInterest` use the `viewFrom` entity's position and cap a veiled mob's range for non-staff viewers other than its pilot; `baseState` writes `trance`, `piloted` | the pilot's view; Stalk |
| `gameplay.ts` | `tick`: skip `thinkMob` when `m.pilot?.steering === 'player'`; `regenMob` and `restored`: return early when `m.pilot`; `attackable` and `dealHits`: a trance body is never a target; `mobDied`: `this.pilot?.beforeShares(m)` before the shares; `playerDied(p, now, killer?)` | no AI under the pilot, no regen or refill in the event, the trance, associates, downs |
| `modules.ts` | `playerDied?(p, now, killer?: Player \| Mob)` (additive) | downs need the killer |
| `connection.ts` | `moveTo`: `if (gameplay.pilot?.steer(player, x, z, now)) return` first; `chat`: refuse when `pilot.chatBlocked(player)` | movement redirect; chat mute |
| `uniques.ts` | `Tracked.event` (fury off, no reset while set); `hold(code, until)`; `spawnForEvent(code, now)`; `endEvent(code, now, how)`; `pilot` in `gm()`; `summonPolicy` asks the pilot's scaling (layer 5) | her lifecycle stays in `uniques` |
| `mob-skills.ts` | `readyAt(m, code)`, `adopt(m, ids)` (Call the Pack joins her summons), `summonerOf(id)` | private state |
| `mounts.ts` | public `stepDownFor(p, now)` | dismount before the trance |
| `game.ts` / `db.ts` | `persist` adds the time since the last persist to `characters.played_ms` | play-time eligibility |

### 3.2 Input reaches the mob

**The link.** `m.pilot = { player: p.id, steering: 'player' }`, `m.ai = 'chase'`, `m.target = null`; `p.viewFrom =
m.id`, then `World.refreshAround(p)`. [decision] `m.ai = 'chase'` because `Uniques.behave` resets a boss that is idle
with an empty damage map, and `dealHits` makes a `return` mob evade everything.

**Moving** (`steer(p, x, z, now)`, called first in the `moveTo` case; false = not the pilot, the normal path runs):

1. any input while the AI steers takes control back (§3.4);
2. held (`skills.held(m)`: stun, knockdown) or busy (`mobSkills.busy(m)`): dropped silently, as a gated move;
3. the target is clamped radially into the hunt circle (§3.6); a point in a safe area is refused;
4. `world.moveEntity(m, x, z, m.def.runSpeed × speedMul × (stalking ? 0.4 : 1), now)`: **the server picks the speed**,
   and the walk is the same straight navmesh chord as a player's, stopped at the first blocking edge;
5. clears auto-claw; `lastInputAt = now`.

`stopAction` from the pilot halts her. The global 20 msg/s budget covers the KeyMover's ≤ 10/s [confirmed].

**Acting** (`pilotAct {ability, target?, x?, z?, repeat?}`), checked in order: the sender is the live pilot (else
`no_event`); the ability is in the kit; she is alive, not held (`cant_act`), not busy (`busy`); 500 ms since the
last act; off cooldown (`MobSkills.readyAt` for retail rows, the kit's own map for new ones; `cooldown`); charges left
(`no_charges`); the target is in the pilot's `known` set and attackable (`Gameplay.target`: alive, visible, not in a
safe area; else `not_found` / `invalid_target`); in reach (`MobSkills.reach(m, row, t)`). Out of reach by ≤ 8 m: she
walks into reach (re-plan every 300 ms to `reach × 0.8`, the AI's chase rule) and then acts; farther: `too_far`.
Retail rows then run `mobSkills.use(m, row, target, now)` unchanged, so the cast timing, the release slack, the
statuses and `m.nextSwingAt` hold for her exactly as for the AI. `repeat: true` (a click on a hunter) is auto-claw:
the module's tick swings ATTACK01 whenever in reach and `now ≥ m.nextSwingAt`, chasing up to 20 m.

### 3.3 The trance

- **On accept**: dismount (`stepDownFor`); `World.warp` to the trance point + `Gameplay.warped(p, 'gm')` (ends a trade,
  a stall, alchemy, casts and dialogs [confirmed hooks]); sit; full HP/MP; harmful effects removed; `p.trance = true`.
- **Where**: `pilot.trancePlace`, a `places.json` name. [unknown] There is no shrine in Jangan town; default
  `palace-steps` until a shrine prop is placed (a new `boss-shrine` place row, no code).
- **Locked**: the module's `gate` refuses every request and `moveTo` of a trance body (`piloting`) except the pilot
  requests and `stopAction`; free chat is refused; the jump is refused.
- **Cannot be hurt**: `dealHits` ignores a trance target and `attackable` is false (it is in a safe area anyway).
- **Shown**: `EntityState.trance` → the body sits with a faint aura and the label line "In a trance".
- **Ends**: `viewFrom` and `trance` cleared, the character stands up at the shrine. [decision] It stays in town: safe,
  and the crowd is 1.3 km away in the fields.

### 3.4 AI fallback and handover

At the hunt start: `m.home` = the start camp's centre, `m.leashRange` = `hunt.radiusM`, `Tracked.event = true`, and
`m.pilot` stays set for the whole event (AI time included), so the three rules below hold whoever steers.

| Today [confirmed] | In the event [decision] |
|---|---|
| leash 50 m from the camp, then `return` (evades every hit) and a reset | leash = the hunt circle: the AI chases anyone hitting her inside it |
| `restored` refills HP at home; `homeReached` resets adds and enrage | no refill, no reset |
| 5 %/2 s regen out of combat (full in 40 s) | no regen: hiding never heals her |
| fury ×2 after 10 min of fight | off: the 15-minute timer is the clock; ×2 in its last third would decide every hunt |

- **player → ai**: no input for `idleSec` 20 (warning at 15 s), disconnect (`forget`), `pilotQuit`, or the body killed
  by a GM. `steering = 'ai'`, auto-claw and Stalk end; `Gameplay.tick` runs `thinkMob` from the next tick, which picks
  the top damage dealer inside the circle (`nextTarget`). `entityUpdate {piloted: false}`.
- **ai → player**: any input while the turn lasts: `steering = 'player'`, `m.ai = 'chase'`, halt. `piloted: true`.
- **Disconnect ends the turn** [decision: no reconnect grace in v1, §9 Q1]; the AI finishes the event.
- `steered_ms` counts player time only; rewards use it.

### 3.5 The kit

Data in `content/uniques.json` `pilot.kit` (§5.5). New abilities send `cast {skill: 'PILOT_TIGERWOMAN_<ID>', clip}`
(the additive `cast.clip`, §5.2) and their hits reuse a retail row's damage roll (`MobSkills.rollHits`) and
`Gameplay.dealHits`, so the damage, the combat messages and the hit effects are today's.

| Key | Ability | Mechanics | Cooldown |
|---|---|---|---|
| 1 | Claw | ATTACK01 through `mobSkills.use`; `repeat` = auto-claw | row: 3 s |
| 2 | Sweep | ATTACK02: 4 m around her, ≤ 5 targets | row: 4.5 s |
| 3 | Curse | ATTACK03: 15 m, magic, `zombie` | row: 5.5 s |
| 4 | Pounce (new) | a target or ground point ≤ 12 m; `World.walkEntity` at 24 m/s (a navmesh walk: stops at walls, clamped to the circle); clip ATTACK1; on landing ATTACK02's roll × 0.6 on players within 3 m, plus `knockdown` (existing status) | 12 s |
| 5 | Fear Roar (new) | hunters within 8 m: `knockback` (existing, 1 s, blocks) through `skills.applyStatus`, pushed 5 m away along a straight walk at 10 m/s; the module's gate refuses their `moveTo`, `attack` and `useSkill` for 1.5 s (`cant_act`), because no gate stops a stunned player's `moveTo` today; clip FIND; no damage | 20 s |
| 6 | Call the Pack (new) | 2 White Tigers (normal) 1.5–3.5 m away (`createMob`, as summons do), attacking her target or the nearest hunter; `adopt`ed into her summons (they leave with her and count toward `maxAlive`); **2 charges** per hunt; clip HELP | 30 s |
| 7 | Stalk (new) | `m.veil = 8`: hunters see her only within 8 m (the next interest pass, ≤ 200 ms, despawns her for the rest); her speed ×0.4 (3.6 m/s, slower than hunters on foot); ends on any act, any damage taken, after 20 s, or on AI handover | 25 s from the end |

[decision] Stalk is server-side interest, not a client fade: a hacked client cannot see what it is never sent. [decision]
Layer 2 allows Stalk anywhere outside towns: the server has no grass data [confirmed]. "Only in tall grass" needs a
per-region cover bitmask from the converter (2 m cells where the client's grass weight ≥ 0.45, the same tile rule as
`grass/bake.ts`); it is a later cut-in with a fallback to "anywhere" when the file is missing.

### 3.6 Hunt mechanics

- **Area**: a circle of `hunt.radiusM` 350 m around the start camp. Steering and abilities clamp into it. No town lies
  inside any camp's circle (≥ 1,030 m away [computed]), so "town camping" cannot happen; the clamp is the pull-back.
- **Pings**: every `pingSec` 60 (first at +60 s): `huntPing {x, z, r: 60}` to every world player but the pilot, centred
  at her position plus a random offset ≤ 40 m (the circle always contains her). Sent while she stalks too.
- **Footprints**: her position every 3 s while moving, kept 90 s. Every 2 s, hunters within 40 m of a new point who do
  not have her entity get those points (`huntTrail`). The client draws paw prints that fade over 90 s.
- **Roars**: every 30 s and on each Fear Roar, hunters 120–400 m away get `huntRoar {bearing, distM}`; the client plays
  her roar (`UNIQUE_ROARS.MOB_CH_TIGERWOMAN`) from that direction, quieter with distance.
- **Speed**: she runs 9 m/s, hunters 5.5 on foot [confirmed]. Horses run 9.9 but riders cannot attack: horses track,
  feet fight. `speedMul` (default 1) is a setting.
- **Taunts**: `pilotTaunt {line}` (0–7, 4 s cooldown) → `huntTaunt {id, line}` to her viewers; the client shows a
  bubble and "[Tiger Girl] Too slow." Lines are client i18n keys, so nothing typed ever reaches anyone.

### 3.7 Scaling (layer 5; built: `pilot/scale.ts`)

N = distinct non-associate players who dealt ≥ `minDamage` 200 to her in the last `windowSec` 60.
s = (clamp(N, `baseHunters` 4, `capHunters` 40) / 4)^`exponent` 0.9. **maxHp = round(47,898 × s).** Recomputed every
5 s; it rises at once and falls at most 10 % per step; `hp` keeps its percentage (so the 80/60/40 summon bands and the
20 % enrage are unchanged); broadcast as `entityUpdate {hp, maxHp}`. Band summons: `perWave = clamp(round(2√s), 2, 6)`,
`maxAlive = 2 × perWave`. The Pack stays 2 per charge. Before layer 5, her HP is today's 47,898 whatever the crowd.

| Hunters N | s | Max HP | Wave / alive | Time to kill at ≈ 50 dmg/s each (UNIQUES §4.1) [projected] |
|---|---|---|---|---|
| 1–4 | 1.00 | 47,898 | 2 / 4 (today) | 4 friends: 4.0 min; a solo hunter: 16 min (cannot win) |
| 10 | 2.28 | 109,300 | 3 / 6 | 3.6 min |
| 20 | 4.26 | 203,900 | 4 / 8 | 3.4 min |
| 40 | 7.94 | 380,500 | 6 / 12 | 3.2 min |
| 60 | 7.94 (cap) | 380,500 | 6 / 12 | 2.1 min |

A bigger crowd still wins a little faster, but four friends and sixty strangers both need minutes of pinned fighting.

### 3.8 Downs and the win

A **down** is a `playerDied(p, now, killer)` where the killer is her, one of her summons (`summonerOf`) or her DoT
(`dealHits`' attacker), and `p` is not an associate, is level ≥ `downMinLevel` 15, and dealt ≥ 200 damage to her or her
summons since his last respawn. [decision] The last rule means a feeder must really fight each time; no per-victim cap,
because four friends could then never give fifteen downs. Each down updates `huntEvent`, `pilotState` and a chat line
"[Hunt] Mei was mauled by Tiger Girl! (6 / 15)". She wins at `downsTarget` 15 or at `huntEndsAt`. [unknown] With four
hunters respawning in town 1.3 km away, 15 downs is rare; the timer is their likely loss (§9 Q6).

### 3.9 Lottery, associates, rewards

- **Eligibility** (checked at volunteer and again at the draw; the reason goes to the client): level ≥ `minLevel` 20;
  `played_ms` ≥ `minPlayHours` 10 h; not blocked (`pilot_blocks`); the account did not pilot within `cooldownDays` 14
  nor in the last `recentEvents` 3 events; one entry per account. A restart-refunded turn does not count.
- **Draw**: weight `firstTimerWeight` 3 for an account that never piloted, else 1; the module's seeded random stream
  (as `Uniques.rng`) so tests are exact.
- **Associates** (frozen at accept, plus a live IP check): the pilot's party, guild members, the other characters of
  the pilot's account, and accounts whose game socket shares the pilot's IP (`Connection.ip`). No friends list exists
  [confirmed]. They may fight her. `beforeShares(m)` removes them from `m.damage` before `killShares`, so they get no
  EXP, loot, quest credit or Berserk from her. [decision] Wider than "cannot own loot": one seam instead of two, and it
  also closes EXP farming. They do not count as downs or toward N.
- **Suspect death**: she dies with associates ≥ `associateDamagePct` 25 % of all damage, or within `earlyDeathMin` 3 of
  the hunt start → the pilot's reward is 0, no title, the event is flagged for an admin. No automatic block.
- **Rewards** (paid at the end through an inventory transaction, the `gmItem` path): gold = `baseGold` 5,000 +
  `perDownGold` 500 × downs + `perMinuteGold` 300 × steered minutes + `winGold` 10,000 on a win. Early loss (2 min,
  1 down) ≈ 6,100; a good loss (12 min, 8 downs) ≈ 12,600; a win (15 min, 10 downs) ≈ 24,500; a hunters' kill is worth
  ≈ 30,000 to a party (UNIQUES §3.4). Title "Spirit of the Tiger" on a win (`EntityState.honor`, permanent). Cosmetic:
  a Wardrobe dye once wave 14 ships [unknown: none until then]. Never gear. Quit, disconnect or a suspect death:
  nothing.

### 3.10 Anti-abuse

| Abuse | Guard |
|---|---|
| idle or AFK pilot | AI after 20 s; reward follows steered minutes |
| disconnect to dodge a loss | the AI finishes; no reward; the turn counts |
| dying on purpose for friends | associates stripped; suspect flag; reward 0 |
| abusive chat | the pilot's free chat is refused for the whole turn (all channels); taunts are fixed lines, 4 s cooldown |
| town camping | the hunt circle; towns ≥ 1 km away; mobs never hit into safe areas anyway |
| speed / teleport hack | the server picks her speed; every move and Pounce is a navmesh walk from her live point, clamped |
| skill spam, range hack | server cooldowns, busy/held, 500 ms between acts, reach, the `known` set, `CLIENT_RATE_LIMITS` |
| spoofed accept | `pilotAnswer` only from the offered account, inside its 30 s |
| repeat picks, alts | one entry per account; 14-day cooldown; 3-event rule; 10 h of counted play; IP associates |
| feeding downs | the down rules of §3.8 |
| HP-scaling griefing | N counts only non-associates with ≥ 200 recent damage |
| the trance body | gate (`piloting`), never a target |
| AI's run home evades hits | accepted: it only happens when nobody inside the circle is fighting her |
| GM misuse | every `/unique pilot` and admin action audited (`gm_audit`) |

---

## 4. Client design

### 4.1 Seams

| File | Seam |
|---|---|
| `screens/world.ts` | `focusView()` = the piloted mob's view while piloting, else `selfView()`; used for the camera follow, `ground.follow`, `world.update`, the minimap, the music/town check and the sound listener (one function, so none is missed) |
| `world/features.ts` | `WorldFeatureContext.controlledId?(): number \| null` (the mob while piloting, else self); `pilotFeature` in `WORLD_FEATURES` after `skillsFeature`, before `movementFeature` (which stays last) |
| `features/keymove.ts` | `self()` and the `move`/`stop`/`warp` echoes use `ctx.controlledId?.() ?? ctx.selfId()`; the speed is the controlled view's latest `move` (9 m/s); it still sends `moveTo` |
| `features/skills.ts` | `hotbar.N` bindings get `when: () => !piloting`, so the pilot's 1–7 win without a warning |
| `world/skills-view.ts` | an unknown skill with `msg.clip` builds a minimal def that plays that clip type |
| `world/entities.ts` | `trance`: sit pose + aura + label line; `piloted`: the label line "steered by a player" |

### 4.2 Pilot controls and camera

WASD (camera-relative, the KeyMover) and ground clicks move her; a click on a hunter targets him and starts
auto-claw; **1–7** use the kit on the target (Pounce on the target, else the ground under the cursor); **hold Q** opens
the taunt wheel, release over a line sends it [unknown: if Q is bound, the pilot binding wins while piloting]; Esc menu
"Leave the hunt" (confirm) sends `pilotQuit`; Space does nothing. The camera targets her composite focus height and
zooms out 1.5× on start, restored at the end [decision: she is 3 m tall and 7 m long].

### 4.3 Pilot HUD (mockup section 2)

- **Boss frame** (top left): portrait, "Tiger Girl (you: Pixi)", HP bar with numbers, "Boss stats: fixed · enrage at
  20 % HP"; an "Enraged" tag from `pilotState.enraged`.
- **Strip** (top centre): SURVIVE mm:ss, HUNTERS DOWNED n / 15, HUNTING YOU n (`pilotState.hunting`).
- **Minimap**: hunters as red dots inside a 60 m ring only (`senseM`; the entities are already on the client).
- **Kit bar** (bottom centre): 7 slots with icons, names, cooldown sweeps (`CooldownSweep` from `hud/slots.ts`),
  charges ("2 left"), greyed while busy or held.
- **Taunt wheel**: 8 fixed lines around Q.
- **Steering line**: "Idle: her own AI takes over in 5 s"; "Her own AI has taken over. Move or act to take back
  control."; chat "[System] Your body rests in a trance at the palace steps (safe)."

### 4.4 Hunters

The hunt banner (top centre, under the notices): "Tiger Girl was sighted! Area: North-Tiger Mt." and "next sighting in
0:42 · she wins in 11:42 · 63 hunters"; the ping circle "Last sighting" on the minimap and the world map, fading over
60 s; paw prints on the ground (one thin-instanced draw for all prints); distant roars; down lines in chat; her label
line "steered by a player"; the result banner through the `NoticeBanner` queue (`kind: 'unique'`, as today's notices).

### 4.5 Call and offer

The call banner (mockup section 1, left): title "Unique Event", the question, "Draw in 9:41 · 37 volunteers · level 20
only", **Volunteer** / **Not this time** (a toggle: `pilotVolunteer {on}`), or the reason when ineligible. The offer
dialog (right): the four rule lines, **Accept** / **Decline**, "Accept within 0:27"; it closes itself when the server
moves on. Both are world-screen only, like `unique-notice.ts`.

### 4.6 i18n keys (`apps/game/src/i18n/en-pilot.ts`)

`pilot.call.{title,question,meta,volunteer,withdraw,chat,soon}`,
`pilot.call.why.{level,playtime,cooldown,recent,blocked,dead,busy}`,
`pilot.offer.{title,question,ruleTrance,ruleStats,ruleWin,ruleIdle,accept,decline,timer}`,
`pilot.hud.{you,fixed,enraged,survive,downed,hunting,charges,idleWarn,aiTook,trance,quit,quitConfirm}`,
`pilot.ability.{claw,sweep,curse,pounce,roar,pack,stalk}.{name,desc}`, `pilot.taunt.0`–`7` ("I smell fear.", "The
mountain is mine.", "Run, little rabbit.", "Who's next?", "RRRAAAGH!", "Too slow.", "Come closer.", "You hunt? I
hunt."), `pilot.taunt.chat`, `pilot.result.{title,won,lost,gold,downs,time,forfeit}`,
`hunt.{title,sighted,meta,ping,steered,trance,down}`, `hunt.end.{survived,downs,cancelled,noVolunteers,pilot}`,
`fail.{piloting,not_eligible,no_event,no_charges}`.

---

## 5. Protocol and migrations (protocol v1, additive)

### 5.1 Client → server (all `GameplayRequest`s, answered by `actionResult`; added to `GAMEPLAY_REQUESTS`)

```ts
| { t: 'pilotVolunteer'; on: boolean }                    // 1/s, burst 3; whileDead
| { t: 'pilotAnswer'; event: number; accept: boolean }    // 1/s, burst 3
| { t: 'pilotAct'; ability: string; target?: number; x?: number; z?: number; repeat?: boolean }  // 5/s, burst 10; ability /^[a-z]{1,16}$/
| { t: 'pilotTaunt'; line: number }                       // 1/s, burst 2; 0..15
| { t: 'pilotQuit' }                                      // 1/s, burst 2
// moveTo and stopAction are unchanged on the wire; the server steers her while you pilot.
```

`ActionFailReason` += `'piloting' | 'not_eligible' | 'no_event' | 'no_charges'`. Pilot requests stay subject to the
stall and trade lock gates like any request [confirmed: allowlist gates].

### 5.2 Server → client

```ts
/** World sockets: the event's public state, on every change (volunteer count at most every 2 s) and on enter-world. */
| { t: 'huntEvent'; event: HuntEventView }
/** The drawn player only. */
| { t: 'pilotOffer'; event: number; expiresAt: number; surviveMin: number; downsTarget: number; idleSec: number }
/** The pilot: control starts. */
| { t: 'pilotStart'; event: number; mob: number; kit: PilotKitView[]; huntEndsAt: number; downsTarget: number;
    area: { x: number; z: number; r: number }; taunts: number; senseM: number; place: string }
/** The pilot, on change. `ready`: ability → server ms it is ready. */
| { t: 'pilotState'; steering: 'player' | 'ai'; idleWarnAt?: number; hunting: number; downs: number;
    charges: Record<string, number>; ready: Record<string, number>; enraged?: boolean; stalkUntil?: number }
| { t: 'pilotEnd'; event: number; reason: PilotEndReason; gold?: number; honor?: string }
/** Hunters. */
| { t: 'huntPing'; event: number; x: number; z: number; r: number; at: number }
| { t: 'huntTrail'; points: [number, number, number][] }   // x, z, server ms
| { t: 'huntRoar'; bearing: number; distM: number; at: number }
| { t: 'huntTaunt'; id: number; line: number }

interface HuntEventView {
  id: number; mob: string; name: string
  phase: 'call' | 'offer' | 'hunt' | 'ended'
  callEndsAt?: number; volunteers?: number; minLevel?: number                 // minLevel: built (the banner's "level 20 only")
  you?: { volunteered: boolean; eligible: boolean; why?: PilotIneligible }   // per recipient
  huntEndsAt?: number; downs?: number; downsTarget?: number; hunters?: number; area?: string
  steering?: 'player' | 'ai'
  outcome?: 'killed' | 'survived' | 'downs' | 'no_volunteers' | 'cancelled' | 'restart'
  pilot?: string                                                             // only when ended
}
interface PilotKitView { id: string; slot: number; clip: string; rangeM: number; cooldownMs: number; charges?: number; target: 'entity' | 'point' | 'none' }
type PilotIneligible = 'level' | 'playtime' | 'cooldown' | 'recent' | 'blocked' | 'dead' | 'busy'
type PilotEndReason = 'killed' | 'survived' | 'downs' | 'quit' | 'cancelled'
```

Additive fields: `cast.clip?: string` (animation type for server-built abilities); `EntityState.trance?: true`,
`EntityState.piloted?: true`, `EntityState.honor?: string` and the same three on `entityUpdate` (booleans there).
Validators in `validate.ts`; the mock server (`net/mock.ts`) emits `huntEvent`/`pilotStart` for `/unique pilot attach`
so the HUD lane can work without the real server. The shared settings and admin types live in a new
`packages/shared/src/pilot.ts` (exported from `index.ts`), not in `protocol.ts`, to stay clear of the admin lane.

### 5.3 Migration N (layer 1; N = 11 unless another lane lands first)

```sql
CREATE TABLE pilot_events (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,                 -- MOB_CH_TIGERWOMAN
  origin TEXT NOT NULL,               -- 'schedule' | 'gm' | 'admin'
  phase TEXT NOT NULL,                -- 'call' | 'draw' | 'hunt' | 'ended'
  created_at INTEGER NOT NULL,
  call_ends_at INTEGER, hunt_started_at INTEGER, hunt_ends_at INTEGER, ended_at INTEGER,
  outcome TEXT,                       -- §5.2 HuntEventView.outcome
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
  kind TEXT NOT NULL,                 -- call, volunteer, offer, accept, decline, timeout, spawn, takeover, ai, player, down, end, reward, flag, gm
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX pilot_log_event ON pilot_log(event_id);
ALTER TABLE characters ADD COLUMN played_ms INTEGER NOT NULL DEFAULT 0;
```

[decision] `played_ms` lands in layer 1, unused until layer 4, so the counter has weeks of play when the lottery opens.

### 5.4 Migration N+1 (layer 4; built as migration 14, without `pilot_honors`, which landed in 13)

```sql
CREATE TABLE pilot_settings (code TEXT PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, updated_by INTEGER);
CREATE TABLE pilot_volunteers (event_id INTEGER NOT NULL REFERENCES pilot_events(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL, character_id INTEGER NOT NULL, at INTEGER NOT NULL, draw TEXT,
  PRIMARY KEY (event_id, account_id));
CREATE TABLE pilot_blocks (account_id INTEGER PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL,
  by_account INTEGER, at INTEGER NOT NULL);
CREATE TABLE pilot_honors (character_id INTEGER NOT NULL, code TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (character_id, code));
```

### 5.5 `content/uniques.json`: the `pilot` block (`UniqueDef.pilot?: PilotDef`, checked by `checkUniquesFile`)

```json
"pilot": {
  "trancePlace": "palace-steps",
  "kit": [
    { "id": "claw",   "slot": 1, "row": "MSKILL_CH_TIGERWOMAN_ATTACK01" },
    { "id": "sweep",  "slot": 2, "row": "MSKILL_CH_TIGERWOMAN_ATTACK02" },
    { "id": "curse",  "slot": 3, "row": "MSKILL_CH_TIGERWOMAN_ATTACK03" },
    { "id": "pounce", "slot": 4, "kind": "leap",   "rangeM": 12, "speedMs": 24, "cooldownMs": 12000, "clip": "ATTACK1",
      "hit": { "row": "MSKILL_CH_TIGERWOMAN_ATTACK02", "mul": 0.6, "radiusM": 3, "status": "knockdown" } },
    { "id": "roar",   "slot": 5, "kind": "fear",   "radiusM": 8, "pushM": 5, "lockMs": 1500, "cooldownMs": 20000, "clip": "FIND" },
    { "id": "pack",   "slot": 6, "kind": "pack",   "mob": "MOB_CH_WHITETIGER", "count": 2, "charges": 2, "cooldownMs": 30000, "clip": "HELP" },
    { "id": "stalk",  "slot": 7, "kind": "stalk",  "revealM": 8, "maxMs": 20000, "speedMul": 0.4, "cooldownMs": 25000, "cover": "anywhere" }
  ],
  "defaults": { "…": "every PilotSettings field of §6.2" }
}
```

---

## 6. Admin integration contract

### 6.1 Where it lives, and why [decision]

- **Content** (`content/uniques.json` `pilot`): the kit and the **defaults** of every number. Balance data, reviewed in
  git with the code that reads it, checked at start like the rest of the file.
- **Database** (`pilot_settings`, one row per unique): a **sparse patch** over those defaults, validated by the same
  checker. Effective settings = defaults ⊕ patch. The schedule and the live numbers are per-server operator choices
  that change weekly; they must apply at once without a content reload, survive a repo deploy (which replaces
  `content/`) and sit in the same backup as the events they govern. Not env vars: those are read once at start
  (`config.ts`). Not a `DATA_DIR/content` override file: those are for world content and need a reload pass.

### 6.2 Settings schema (`PilotSettings`, `packages/shared/src/pilot.ts`, with `PILOT_BOUNDS` and `checkPilotSettings`)

| Group | Field | Default | Bounds |
|---|---|---|---|
| — | `enabled` (scheduled nights on; GM/admin starts always work) | false | – |
| schedule | `slots: {weekday 0–6, time 'HH:MM'}[]`, `tz` (IANA) | `[{6, '21:00'}]`, the server's zone | 0–7 slots |
| call | `minutes`, `acceptSec`, `maxDraws` | 10, 30, 5 | 1–60, 10–120, 1–20 |
| eligibility | `minLevel`, `minPlayHours`, `cooldownDays`, `recentEvents`, `firstTimerWeight` | 20, 10, 14, 3, 3 | 1–cap, 0–500, 0–90, 0–20, 1–10 |
| win | `surviveMin`, `downsTarget`, `downMinLevel`, `downMinDamage` | 15, 15, 15, 200 | 3–60, 1–200, 1–cap, 0–10,000 |
| hunt | `radiusM`, `pingSec`, `pingRadiusM`, `idleSec`, `speedMul`, `senseM` | 350, 60, 60, 20, 1.0, 60 | 100–1,000, 15–300, 20–200, 10–120, 0.8–1.5, 20–120 |
| scaling | `on`, `baseHunters`, `exponent`, `capHunters`, `windowSec`, `minDamage` | true, 4, 0.9, 40, 60, 200 | –, 1–20, 0.5–1, 4–200, 15–300, 0–10,000 |
| rewards | `baseGold`, `perDownGold`, `perMinuteGold`, `winGold`, `title`, `cosmetic` | 5,000, 500, 300, 10,000, 'tiger_spirit', null | 0–1,000,000 each |
| guards | `associateDamagePct`, `earlyDeathMin`, `tauntCooldownSec` | 25, 3, 4 | 0–100, 0–15, 1–60 |

### 6.3 Service and endpoints

The pilot module exports **`routeAdminBoss(ctx, req): Promise<{status, body}>`** with `req = {method, path, query,
body, actor: {accountId, role}}`. The admin panel's router authenticates (its owner/admin login), then delegates every
`/api/admin/boss/*` path to it. The handler requires `role === 'admin'` (or the panel's owner role), writes a `gm_audit`
row per write (command `pilot`, the action and its args), and answers JSON (`ApiError` on failure). The GM commands
call the same service functions, so both paths share one set of rules.

| Method, path | Body / query | Answer |
|---|---|---|
| GET `/api/admin/boss` | – | `{uniques: [{code, name, alive, hpPct, phase}], current: HuntEventView & {pilot, steering, flags} \| null, nextNight: ms \| null, settings: {defaults, patch, effective, rev, bounds}}` |
| PUT `/api/admin/boss/settings` | `{code, baseRev, patch}` | 200 `{effective, rev}`; 409 stale `baseRev`; 422 `{issues: [{path, message}]}` |
| POST `/api/admin/boss/settings/reset` | `{code, paths?: string[]}` (none = all) | 200 `{effective, rev}` |
| POST `/api/admin/boss/start` | `{code, callMinutes?}` | 200 `{event}`; 409 an event is running |
| POST `/api/admin/boss/pick` | `{code, character}` | 200 `{event}`; 404 not online |
| POST `/api/admin/boss/stop` | `{code, reason?}` | 200 `{event}`; 409 nothing running |
| GET `/api/admin/boss/events` | `?before=<id>&limit=50` | `{events: PilotEventSummary[]}` |
| GET `/api/admin/boss/events/:id` | – | `{event, log: PilotLogLine[], volunteers: [{name, account, at, draw}]}` |
| GET / PUT / DELETE `/api/admin/boss/blocks[/:account]` | PUT `{days, reason}` | the block list |
| GET `/api/admin/boss/eligibility` | `?character=<name>` | `{eligible, why?, playedHours, lastTurnAt, weight}` |

As built (layer 4): GET also answers `schedule: {tz, enabled, nextCallAt}`, `settings.patch` and `settings.levelCap`,
and `current.{origin, drawAt, maxHp, scaleHunters}`; PUT settings merges `patch` into the stored patch (a group's
field at a time, `schedule.slots` as a whole); `:account` in the blocks routes is an account id (`#12`), a character
name or an account name; the eligibility answer also carries `character, account, online, level, blockedUntil`. 400
for a malformed body, 403 for a non-admin role on every route, 404 for an unknown name. Each write adds a `gm_audit`
row (command `pilot`) on top of the panel's `admin_audit` row.

### 6.4 The panel page ("Night of the Tiger")

1. **Now**: the phase with its countdown (call: volunteers; offer: who and the seconds left; hunt: time left, downs /
   target, hunters, her HP %, steering player/AI, pilot); **Start now** (call minutes), **Force-pick** (character name),
   **Stop** (confirm).
2. **Schedule**: enabled toggle, weekly slots (weekday + time), time zone, "Next night: Sat 21:00 (in 3 d 4 h)".
3. **Numbers**: the §6.2 groups as forms; each field shows its default, a per-field reset, the bounds, and the 422
   messages inline; saves carry `baseRev`.
4. **Event log**: date, origin, pilot, outcome, length, downs, hunters, gold, flags (suspect rows highlighted); a detail
   view with the timeline (`pilot_log`) and the volunteer list in draw order.
5. **Blocks**: account, until, reason, by; add and remove.
6. **Eligibility check**: a character name in, the reasons out.

---

## 7. Tests

**Unit (vitest, `apps/server/test/pilot-*.test.ts`)**: `steer` (circle clamp, safe-area refusal, held/busy drop,
server speed, input reclaims from the AI); kit (reach, cooldowns, charges, 500 ms gap; Pounce stops at a wall on the
real navmesh; Roar pushes and gates `moveTo` 1.5 s; Pack summons leave with her; Stalk: a hunter at 9 m gets `despawn`
within one interest pass, at 7 m keeps her; staff keep her); AI fallback (idle 20 s → `thinkMob` with home = centre;
no regen, no refill, no reset, no fury); scaling table of §3.7 exactly, HP % kept, falls ≤ 10 %/step; lottery (each
ineligible reason, one per account, weights with the seeded stream, `maxDraws`, timeout); schedule (`Intl` next slot
across a DST change in two zones); associates (`beforeShares`, downs exclusion, suspect flags); settings (bounds,
patch merge, 409 on a stale rev); `checkUniquesFile` on bad `pilot` blocks.

**Integration (in-process server, `test/helpers.ts` Client bots)**: layer 1: `/unique pilot attach`, the pilot's
`moveTo` moves the mob for every viewer, claw hits a bot, the body cannot be hurt, idle handover and reclaim. Full
event: a call, 6 volunteers, a decline, a timeout, an accept, 15 hunters, downs counted, a kill with the loot on the
top non-associate group and the defeat notice; a second run won on the timer, a third on downs. GM `stop` in each
phase.

**Abuse** (`abuse-pilot.test.ts`, the house's abuse-file style): `moveTo` 500 m away (clamped); `pilotAct` from a
non-pilot, on a far or unknown target, during cooldown, with charges spent, `line: 99`; `pilotAnswer` from another
account or late; volunteering while ineligible or twice from one account; free chat while piloting; attacks on the
trance body; Pounce into a wall; an associate's last hit (no loot); alt suicides (no downs without 200 damage).

**Restarts** (`soak-host.ts` style, graceful restart): during the call (resumed, volunteers kept), during an offer
(redraw at +3 min), during the hunt (outcome `restart`, refund, the AI boss back 1–2 min after boot, the pilot enters
in town).

**Load: 20 / 50 / 100 hunters.** Server: a `soak.ts` variant (`pilot-load.ts`), one bot pilot plus N bot hunters that
ride to her ping and fight (CAPACITY raised to 120). Sample every 30 s: tick mean/p99, event-loop lag, messages and
bytes sent per second, RSS. Pass: tick p99 < 50 ms (half of a 10 Hz tick) at 100. Client: the wave-11 bench's
"20-player Tiger Girl fight" scene with 20, 50 and 100 bots on WebGPU and WebGL2 Medium, p95 frame time; the gate at 20
is G1 (≤ 16.7 ms); 50 and 100 are recorded and gate layer 5 only after the CHAR_PERF crowd tier lands.

---

## 8. Build layers (each playable alone)

| Layer | Delivers | Gate |
|---|---|---|
| 1. Steer her + AI fallback | the server seams of §3.1 for steering, trance, interest anchor, AI handover, chat mute, no-regen rules; `/unique pilot attach/detach`; the client focus seam, KeyMover on the controlled id, click-to-claw, HP frame and steering line; migration N | a GM attaches a friend; WASD and clicks move her for everyone; claw hurts bots; 20 s idle hands her to the AI and a key takes her back; unit + layer-1 integration tests green |
| 2. Boss kit + HUD | the kit (§3.5), `cast.clip`, taunts, pings, footprints, roars, timer/downs rules and the end flow (with `attach` as the start), the full pilot HUD, hunter banner and fx, i18n | a 4-friend test hunt ends by timer, downs and kill; Pounce never crosses a wall; Stalk hides her from 9 m |
| 3. GM pick | the event state machine without call or lottery: `/unique pilot <name>`, offer/accept, spawn or takeover, events + log, restart rules, result window | **the user and friends play here**; restart tests green |
| 4. Public event **(built)** | call, volunteers, eligibility, draw, schedule, settings store and `routeAdminBoss`, rewards and titles, associates and flags, blocks; migration N+1 (migration 14) | a scheduled night on staging with bots; the admin panel drives it end to end; abuse tests green |
| 5. Big crowds **(scaling built; serialize-once and the load runs open)** | HP and summon scaling; serialize each broadcast once (`World.broadcastAbout` hands one string to every socket); the load runs of §7 | server pass at 100; client G1 at 20; 50/100 numbers recorded, 100 only with the CHAR_PERF crowd tier |

---

## 9. Risks, open questions, effort

### 9.1 Risks

| Risk | Mitigation |
|---|---|
| The client focus seam misses a "where am I" read (town music in the field, sound listener at the shrine) | one `focusView()`; a test greps `selfView()` uses in the frame loop |
| KeyMover prediction tuned for 5.5 m/s feels loose at 9 m/s | it already takes the latest `move` speed; layer 1 gate is played by hand |
| Pounce at 24 m/s with ATTACK1 may slide on the ridden composite | look at it in the viewer first; fallback: a 0.5 s RUN at speed with a dust puff |
| The AI's run back to the centre evades hits for up to ≈ 40 s | only when no attacker is inside the circle; leave as is |
| 100 hunters: the client is far past 60 fps without the CHAR_PERF crowd tier; the server sends ≈ 60,000 messages/s, ≈ 70 Mbit/s [projected: 100 viewers × (4 key moves + 1 swing)/s each, ~150 B per JSON message] | layer 5 is gated on CHAR_PERF; serialize once; CAPACITY must be raised from 50 |
| Associates by IP also catch housemates who are honest hunters | they can still fight; they only lose EXP and loot from her |
| Another lane takes migration 11 first | renumber at merge, as wave 11 did |
| The admin panel's auth model is not known yet | the handler takes an already-authenticated `actor` and re-checks the role itself |

### 9.2 Open questions (each with the default used)

1. Reconnect grace for a disconnected pilot? Default: none; the AI finishes, no reward.
2. Name the pilot during the hunt? Default: only in the result.
3. The trance spot: default `palace-steps` until a shrine prop and a `boss-shrine` place exist.
4. Stalk in tall grass only? Default: anywhere outside towns until the converter's cover mask exists.
5. Associates lose EXP too, not only loot? Default: yes (§3.9).
6. Downs target vs small groups (15 is rare with 4 hunters respawning 1.3 km away)? Default: 15, editable; an event
   respawn point near the hunt area is a later idea.
7. The cosmetic: default none until Wardrobe ships its dyes; then a "Tiger Spirit" dye.
8. Existing characters start with `played_ms` 0. Default: no back-fill; the counter runs from layer 1.
9. The schedule's time zone: the server process's (`Intl.DateTimeFormat().resolvedOptions().timeZone`), the user's decision; the panel shows it and does not offer `schedule.tz`.
10. Hunters on horses (9.9 m/s) outrun her (9 m/s): default yes; riders cannot attack.

### 9.3 Effort (agent-days)

| Layer | Server | Client | Tests | Total |
|---|---|---|---|---|
| 1 | 3.5 | 3 | 1.5 | **8** |
| 2 | 5 | 4.5 | 2 | **11.5** |
| 3 | 3 | 1 | 1.5 | **5.5** |
| 4 | 6 | 2 | 3 | **11** |
| 5 | 2 | 0.5 | 2 | **4.5** (plus the CHAR_PERF crowd tier, its own wave) |
| | | | | **≈ 40** |

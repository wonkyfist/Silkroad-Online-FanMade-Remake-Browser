# Network audit (Overall Pass, item 17)

Scope: everything between the browser and the simulation — `apps/server/src/{game,connection,world,auth,origin}.ts`,
`packages/shared/src/{protocol,validate}.ts`, `apps/game/src/net/*`, the client's entity view (`world/entities.ts`).
Date: 2026-10-10. Measured with the new protocol-level bot load test (`pnpm netload`, §7).

## Summary

The architecture was already the right one for this game: a click-to-move MMO with a fully authoritative server.
Clients send intents only (`moveTo x z`, `attack id`, `shopBuy npc item count`, ...); the server pathfinds, simulates
and broadcasts **move segments** (`from, to, speed, startedAt` in server time) rather than per-tick positions, every
inbound frame is schema-validated with exact key sets, there is an area-of-interest grid with spawn/despawn hysteresis,
per-IP socket caps, origin checks, a heartbeat and session tokens stored hashed. The abuse suites (`abuse-*.test.ts`)
already cover item, gold, trade, quest and combat authority.

What the audit found and fixed is mostly in the "100 → 500 players" and "bad network" regimes:

| # | Severity | Finding | Status |
|---|---|---|---|
| N1 | High | One TCP write (syscall) per message per client: at 500 players in one town ~half the server CPU was `writev`, tick p95 65 ms | **Fixed**: per-turn socket corking |
| N2 | High | Hot movement messages printed full doubles (17 digits): `move` ≈ 195 B, `stop` ≈ 108 B; 95 % of all bytes | **Fixed**: cm / mrad on the wire (−37 % bytes) |
| N3 | High | One shared 20 msg/s budget for every message: a 20/s stream (private flight input, or WASD 10/s + skills + pings) starved everything else and struck the socket closed; `moveTo` and `ping` had no budget of their own | **Fixed**: a budget per type + a 60/s flood ceiling |
| N4 | Medium | Interest pass recomputed both positions for every viewer×candidate pair (~0.5 M `positionAt` per pass at 500 in town) | **Fixed**: positions cached per pass |
| N5 | High | A brief disconnect removed the character at once; worse, a reconnect within the Climb's combat linger was **refused** ("still in combat, try again in N s") while the client's auto-reconnect sends `enterWorld` once — the player was stuck | **Fixed**: graceful reconnect (§5) |
| N6 | Medium | The client never noticed a half-open connection (Wi-Fi switch, sleep): no silence watchdog | **Fixed**: 15 s watchdog → reconnect |
| N7 | Medium | A client that stopped reading was closed with `abuse` (4008), which the client treats as fatal and logs the player out | **Fixed**: new non-fatal `CLOSE_CODE.slow` (4011) |
| N8 | Medium | Disconnects were not logged with a reason (only "left as X") | **Fixed**: one `disconnect:` line per socket with who, state and reason; counted by reason |
| C1 | Medium | Client snapped to every server `stop` / redirect (visible pops of ~0.1–0.5 m at normal RTT) | **Fixed**: corrections glide out (τ 80 ms; > 4 m still snaps) |
| M1 | — | No way to measure bandwidth, message mix, tick percentiles | **Added**: `NetStats`, `GET /netstats` (NET_STATS=1, loopback only), `pnpm netload` |
| R1 | Medium | No per-viewer cap on visible players: in one crowded town every client receives every player (500 → 12.5 kB/s and 130 msg/s per client after the fixes) | **Fixed** (decision 2026-10-11): crowd cap, §2 |
| R2 | Low | JSON text frames, no binary encoding | Remains — measured not worth it yet (below) |
| R3 | Low | No global connection-rate limit per IP (only 16 concurrent sockets per IP, 5 s hello timeout) | Remains |
| R4 | Low | `broadcastAbout` scans all players per event (O(N) per event, O(N²) per second) | Remains: < 1 % CPU at 500 |
| R5 | Medium | Local chat was world-wide (UX_GAPS C6): each line went to every player; at 500 players the largest outbound item when spread out, and an N² amplifier (1 line/s each) | **Fixed** (decision 2026-10-11): local chat reaches players within view range |

## 1. Server authority

Verified, no change needed: positions (the client sends a target, the server pathfinds on the navmesh, clamps to bounds
and to the jail, speed is server state — `speed` GM only), combat (targets are ids, ranges/cooldowns/damage server
side), items/gold/prices (slot indexes and NPC ids only; prices from the server's shop tables; stall buys carry what the
buyer saw so a bait-and-switch is refused), quests. Movement "validation" is inherent: there is no client position to
validate, only a target. The private build's flight/swim input is also intent (WASD + vertical), stepped by the server.
Corrections are a server `stop`/`move`; the client now blends them (C1) instead of hard kicks.

## 2. Tick model and interest

Fixed server tick (`TICK_HZ`, 10 Hz on the live config, 20 in tests), event-driven movement: a segment is sent once per
move/stop, not per tick, so per-entity update rate scaling by distance has nothing to scale — a walking player costs
each viewer ~1.4 messages per click, whatever the tick rate. AOI: uniform grid (`viewRange` 120 m cells), spawn inside
120 m, despawn beyond 130 m. Snapshot on enter (`worldEnter.entities`), deltas after (`spawn` / `despawn` / `move` /
`stop` / `entityUpdate`).

**Crowd cap (R1, `World.pickCrowd`).** Each interest pass, a viewer with more than `MAX_VISIBLE_PLAYERS` (env, default
100, 0 = off; shown on the admin dashboard) players in range gets `Player.crowd`: the must-see players plus the nearest
others up to the cap; a player already shown counts `CROWD_SWAP_M` (8 m) nearer, so the edge does not flicker. Must-see
(`World.mustSee`): the viewer's attack/skill target, anyone targeting the viewer, players it hit or was hit by in the
last `FOE_MEMORY_MS` (15 s: PvP cape fights, Bounty Hunter vs Wanted, job fights), party and guild members
(`alsoMustSee`, set by gameplay.ts). Must-see players count toward the cap. Monsters, NPCs, items and horses are never
capped. The cap also applies to the `worldEnter` snapshot and to warps (picked first), so nobody is sent a whole town
only to have most of it despawned 200 ms later.

**Local chat (R5, `World.sayLocal`).** To every player within `viewRange` of the speaker (about the AoI radius), the
speaker included; the crowd cap does not apply (you hear the nearby players you are not shown). Party, guild,
whisper, stall, system and GM notices are unchanged.

## 3. Client

- Remote entities are drawn at the synced server time along their server segment (`sampleMove`). A segment is a plan
  the server will follow exactly, so there is nothing to extrapolate and no interpolation delay is needed; the only
  errors are at events (an early stop, a redirect), which C1 now smooths.
- Own movement: the click walk is predicted on the client navmesh along the server's move; WASD walking sends a
  `moveTo` keep-alive at ≤ 10/s and reconciles to the server's segments (`features/keymove.ts`).
- Clock: ping/pong every 5 s, minimum-RTT sample of the last 8, step detection (`net/clock.ts ServerClock`).

## 4. Message protocol

- JSON text frames, ≤ 4096 B (`WS_MAX_PAYLOAD`), `PROTOCOL_VERSION` checked in `hello` (close 4002 on mismatch).
- Every inbound frame parsed with exact key sets and bounded numbers (`validate.ts`); a bad frame is a strike, 20
  strikes (one forgiven per 3 s) close with 4008.
- Rate limits (N3): `CLIENT_RATE_LIMITS` per gameplay request (answered `actionResult rate_limited`, no strike),
  `MESSAGE_RATE_LIMITS` (connection.ts) for `moveTo` 15/s, `ping` 2/s and lobby requests (moveTo/ping over budget
  dropped silently), chat 1/s, GM 5/s, and a 60/s (burst 120) flood ceiling over all types (strikes).
- Acks: every gameplay request gets exactly one `actionResult`, FIFO per type. Idempotency: the client never re-sends
  a gameplay request (a reconnect re-sends only `hello` and `enterWorld`), and the server applies each frame once in
  order on one socket, so there is no double-spend path; no sequence numbers are needed for that.
- Binary encoding (R2): after N2 a `move` is ~120 B and a `stop` ~60 B of JSON. A hand-packed binary `move` would be
  ~30 B, i.e. another ~3.5× on the hottest messages, at the cost of a second codec on both sides and the private
  build's flight/swim messages. With the visible-player cap (R1) in place first, the bytes per client at 500 in one
  town would already be ~2–3 kB/s, so binary is not worth it now. Revisit if one machine must hold > 500.

## 5. Connection lifecycle

- Heartbeat: server WS ping every 30 s, terminate after a missed pong (logged `heartbeat timeout`); client ping 5 s
  and (N6) a 15 s silence watchdog that drops the socket and reconnects with the same token.
- **Graceful reconnect (N5, `resume.ts`)**: a socket that ends without a goodbye (client close code other than
  1000/1005, heartbeat timeout, socket error, replaced by a new login, `slow`) leaves its character **held** in the
  world for `RESUME_GRACE_S` (default 15 s; 0 in tests unless set): visible, mute, idle. The client's auto-reconnect
  re-sends `enterWorld`; the server then saves and removes the held body and enters the character from that save, so
  position/HP/MP continue exactly and every module sees an ordinary leave → enter. The Climb's combat linger body is
  taken back the same way (`DeathPenalty.reclaim`) instead of refusing the relog. Logout (1000), `leaveWorld`, kicks,
  bans and shutdown never hold. Shutdown saves held bodies (`holds.releaseAll`). A deleted character's hold is
  released first. Known trade-off: a reconnect clears monster aggro on the character (as a relog always did).
- Duplicate login: the older socket is closed `replaced` (4000) and, with N5, its body is handed to the new one.
- Backpressure: frames of one event-loop turn are coalesced (N1); a client with > 1 MiB unsent is closed `slow`
  (4011, N7), reconnects and resumes. Memory per slow client is therefore bounded at ~1 MiB. Dropping/merging stale
  `move`s instead is not safe here: they are events, not snapshots (dropping one desyncs the entity until its next).
- Disconnect logging (N8): `disconnect: <account> (<character>) in <state>: <reason>`; reasons are `client <code>`,
  `server <code> <reason>`, `heartbeat timeout`, `socket error <code>`.

## 6. Security

Session token in `hello` (sha256-hashed at rest, 7-day TTL, max 10 per account), origin check on the upgrade (no
Origin = non-browser client, allowed; a browser always sends one), 16 sockets per IP, 5 s hello timeout, 4 KiB frames,
login failure lockouts per account and per IP, bounded scrypt queue, no secrets in the client bundle (grep).
`/netstats` answers only with `NET_STATS=1` **and** from loopback. Fuzzing: `network-fuzz.test.ts` (20 000 random
frames through the parser; 600 parser-valid frames of 25 types over a live socket — no handler throws) on top of the
existing per-wave abuse/fuzz suites.

## 7. Measurements

`pnpm netload --bots N --scenario town|spread [--duration 60] [--warmup 20]` starts its own server (own temp
DATA_DIR, 127.0.0.1, never the live server) as a separate process and N headless WebSocket bots in one process. Bots
register, create a character, enter, then walk (a new point within 25 m every 4–10 s), fight (30 %: the nearest monster
every 3 s), chat (a local line every 30–90 s), trade (a request every 60–120 s, accepted, then cancelled) and ping
every 5 s. `town` = everyone in Jangan (each bot sees all others); `spread` = a GM bot summons equal shares to every GM
place. Server numbers come from `/netstats` (counters reset after the warm-up); CPU is the server process only.
Machine: the dev PC (Windows 11, 16 GB, Node 24), other work running.

"Before" = this pass's instrumentation with N1, N2 and N4 switched off (a worktree of the same commit); "after" =
all fixes. 60 s measured after a 20 s warm-up; tick budget 100 ms (10 Hz). Server RSS includes ~650 MB of world data
(navmesh, content) at start. No disconnects in any run (server and bots), no bot errors.

| Run | Tick p50 / p95 / max (ms) | Server CPU | Out total | Out / player | Msgs / player / s | In / player | RTT p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|
| town 50 before | 2.2 / 6.0 / 18 | 2.5 % | 103 kB/s | 2.0 kB/s | 13.8 | 15 B/s | 0.4 / 3.2 |
| town 50 after | 2.3 / 5.8 / 616¹ | 4.6 %¹ | 72 kB/s | 1.4 kB/s | 14.6 | 15 B/s | 0.5 / 6.5 |
| town 100 before | 5.8 / 9.9 / 20 | 9.1 % | 419 kB/s | 4.2 kB/s | 27.8 | 15 B/s | 0.4 / 7.5 |
| town 100 after | 3.6 / 7.9 / 635¹ | 9.3 %¹ | 266 kB/s | 2.7 kB/s | 27.5 | 15 B/s | 0.5 / 6.6 |
| spread 100 before | 9.4 / 25.6 / 780¹ | 11.8 % | 87 kB/s | 0.9 kB/s | 6.5 | 16 B/s | 0.5 / 16.8 |
| spread 100 after | 6.0 / 11.3 / 347¹ | 7.6 % | 39 kB/s | 0.4 kB/s | 4.0 | 16 B/s | 0.4 / 8.7 |
| **town 500 before** | **42 / 65 / 120** | **77 %** | **9.99 MB/s** | **20 kB/s** | 133 | 15 B/s | **24.5 / 71.7** |
| **town 500 after** | **24 / 32 / 40** | **46 %** | **6.25 MB/s** | **12.5 kB/s** | 133 | 15 B/s | **6.5 / 32** |
| **town 500 + crowd cap + chat range** | **35 / 40 / 45** | **37 %** | **1.91 MB/s** | **3.8 kB/s** | **35** | 15 B/s | **2.8 / 40** |
| spread 500 before | 23.6 / 30.6 / 39 | 31 % | 1.01 MB/s | 2.0 kB/s | 16.1 | 16 B/s | 0.5 / 27.6 |
| spread 500 after | 18.0 / 23.6 / 33 | 28 % | 0.80 MB/s | 1.6 kB/s | 16.2 | 16 B/s | 0.6 / 22.1 |

¹ These runs overlapped another helper's browser benchmark on the same PC (free RAM fell to ~1.7 GB; the bench lock
came later): the single max-tick outliers (0.3–0.8 s, with matching RTT maxima) are machine stalls, not the server —
the p95 values and the locked 500 runs show no such spikes.

Message mix, town 500 after (per second, server out): move 34 366 (4.19 MB), stop 27 929 (1.70 MB), chat 3 685
(0.33 MB), spawn 81, despawn 81, pong 100, actionResult 10, trade 4. In: ping 100, moveTo 71, chat 7.4, trade 10.
Spread 500 after: chat 3 852 (0.34 MB — the largest item: local chat is world-wide, UX_GAPS C6), move 1 944 (0.24 MB),
stop 1 675, spawn 177, combat 69, cast 41. Bot process: 253–672 MB for 500 bots (one process); server RSS 450–760 MB.

**Crowd cap at 500 in one town** (decision 2026-10-11; locked runs, 60 s). First version (nearest 100 re-picked every
pass, 8 m margin): bytes fell to 8.3 MB/s but the moving crowd churned **8 200 spawns + 8 200 despawns per second** and
the tick p50 rose to 76 ms. Second (shown players sticky with a 30 m margin, one swap per pass): 2.8 MB/s, 1 580
spawns/s, tick p50 78 ms — a profile showed `pickCrowd` at 15 % and the interest pass at 29 % of CPU. Final
(re-pick once a second per viewer, staggered): **1.91 MB/s out (3.8 kB/s and 35 msgs/s per client, from 12.5 kB/s and
133), 517 spawns/s, tick p50/p95 35/40 ms, CPU 37 %, RTT p95 40 ms, no disconnects.** The ticks cost ~10 ms more than
without the cap (the crowd pick), and are well inside the 100 ms budget. In the town scenario every bot is within chat
range, so chat (3 720 lines delivered/s) is unchanged there; spread out, range-limited chat removes the world-wide fan-out.

**Server architecture P0 (2026-10-12, docs/SERVER_ARCHITECTURE.md §4.1).** The monster pass's player grid, the
recipient index, encode-once and the interest pass's quick path (each with an off switch), measured back to back with
them off and on: spread 500 tick p50/p95 18.9/24.6 → 5.7/8.3 ms and CPU 24.8 → 11.2 %; town 500 p95 43.0 → 16.6 ms,
CPU 37.6 → 24 %, RTT p95 42.9 → 16.8 ms; the same messages per client (35/s in town), JSON encodes 17,256/s →
1,300/s. The server now reports its own per-phase split (`GET /netstats` `phases`, the admin dashboard's Performance
card): in a crowded town the socket flush between ticks (~15 ms per 100 ms) is the largest cost left.

**What breaks first at 500 (before the cap).** Nothing broke: no disconnects, ticks well inside the budget, RTT p95 ≤ 32 ms. The
first limit was the crowded-town **fan-out** (now capped, above): every walking player is a message to every other player in view, so the
bytes grow with N² (500 in one town = 6.25 MB/s ≈ 50 Mbit/s up from the server, 12.5 kB/s and 133 messages/s into each
client — fine for the network, heavy for a browser drawing 500 characters). Before this pass the same case spent half
the server CPU in per-message socket writes (fixed, N1) and sent 80 Mbit/s (N2). Second: world-wide local chat, which
also fans out N² (rate-limited to 1 line/s per player, so 500 spammers could push ~250 k messages/s; R5). Server CPU
(46 % of one core at 500 in one town) is not the limit yet; extrapolating the town curve, one core saturates around
700–800 players in one place.

## 8. What remains

- R2 binary encoding: only after R1, and only if a box must hold more than ~500.
- R3 connection-rate limit per IP (e.g. 10 upgrades / 10 s) against reconnect storms from one address.
- A Bounty Hunter / Wanted pair that has not fought yet and does not target each other is not must-see (the
  Hunter's target is, as soon as it attacks).

## 9. Private build: exact steps for the next merge of master into `C:devjangan-private-wt`

1. `apps/server/src/connection.ts onFrame` (conflict). Take master's version of the head of `onFrame` (the shared
   bucket check before parsing, then `parseClientMessage`, `net.recvd`, the `MESSAGE_RATE_LIMITS` check). Delete the
   private exemption block (`if (!(parsed.ok && (parsed.msg.t === 'flyInput' || parsed.msg.t === 'swimInput')) &&
   !this.bucket.take())`): the flood ceiling is now 60/s (burst 120), above flyInput 20/s plus everything else. Keep the
   private binary-frame branch as master has it. Keep `case 'flyInput'` / `case 'swimInput'` and their own budgets
   (`FLIGHT_RATE_LIMITS`, `COURT_RATE_LIMITS` via `takeBudget`); `takeBudget` and master's `budget(t, limit)` do the
   same thing — keep one (master's `budget`) and point `takeBudget` callers at it.
2. `apps/server/src/connection.ts leaveWorld`: keep master's `hold` parameter and the
   `!game.gameplay.penalty.linger(...) && !(hold && game.holds.hold(p, leave))` line. If the private build ends a flight
   or a swim in `forget`/leave, nothing else changes: a reconnect saves and re-enters the character (a flyer lands where
   the save put it, as on any relog).
3. Wire positions: replace `pos: [...p.pos], yaw: p.yaw` with `pos: wirePos(p.pos), yaw: wireYaw(p.yaw)` in
   `flight/flight.ts` (the `stop` after landing, ~line 442) and `drowned-court` (the `warp` ~line 419 and the `stop`
   ~line 495); import both from `../world.ts`. The `fly`/`swim` samples are already rounded (`r2v`).
4. Crowd cap: flight and swim broadcasts go through `broadcastAbout` (known-based), so they follow the cap with no
   change. If the court sends sea-monster samples with its own player loop, filter it by `viewer.known.has(id)`.
5. Client: in the fly/swim entity views, route a sample that jumps the drawn position through the entity's
   `correction` (`CorrectionOffset.set(drawnX, drawnZ, newPos)` before applying it), as `EntityView.stop` does.
6. Tests: run `apps/server/test/network*.test.ts`, `crowd.test.ts`, the flight and court suites, then
   `pnpm netload --bots 100 --scenario town` (under BENCH.lock). `PROTOCOL_VERSION` is unchanged; `CLOSE_CODE.slow`
   (4011) and the admin `maxVisiblePlayers` field are additive.
7. Server architecture P0 (docs/SERVER_ARCHITECTURE.md §4.1, 2026-10-12): see the private-build notes there (no
   conflicts expected; `Player.known` is a `KnownSet`, `Player.send(msg, enc?)`, `World.watchersOf`, `Encoded`).

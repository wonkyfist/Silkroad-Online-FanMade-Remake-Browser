# Server architecture: the multi-core target (2026-10-12)

Status: **design + measurements only, nothing built yet.** Scope: `apps/server` on master and the private branch's
`flight/`, `drowned-court/`, `costume.ts`, `walk.ts`. The user's rule: "having the right architecture from the start
regardless if you use it or not is the ideal way". Target: **2,000+ concurrent players on a 4–8 core VPS** (and more
headroom on the live 4-core N100), with **no client change**.

## 0. The decision in short

- **Measured (§1):** the cost is in the engine core, not in the ~45 gameplay modules (all their hooks together are
  under 3 % of the CPU). At 500 bots it is, in order: the **monster AI and the mob wake check**, dominated by all-player scans
  (52 % of the CPU spread out; also a 4× regression since 2026-10-10), **socket writes** (17–37 %), **the AoI interest
  pass + crowd cap** (44 % in one crowded town). DB saves, chat, nav, timers and events are each under 1 %.
- **Target shape:** `gateway processes` (sockets, auth, decode/validate, rate limits, encode-once fan-out) →
  `internal bus` → `zone workers` (threads; each owns a set of world **cells** and runs the same Gameplay/World code
  over them, with fenced **handoff** and **ghosts** at borders) + `job workers` (AoI/crowd selection, later nav and AI
  batches, on SharedArrayBuffer snapshots) + `global services` (one owner each: accounts, chat channels, party, guild,
  economy, law/jail, events/weather/clock) + **one DB writer thread** (SQLite WAL, journal of ordered idempotent ops,
  group commit, escrow + single-transaction transfers, commit-then-ack for anything with a counterparty).
- **Phases (§4):** P0 measure + kill the O(N²) scans (2–3 days) → P1 gateway processes + AoI job workers (9–12 days)
  → P2 DB writer + service extraction (10–15 days) → P3 zone sharding with handoff/ghosts (20–30 days) → P4 cell
  rebalancing + multi-machine transport (8–12 days). Every phase has an off switch (`GATEWAYS=0`, `ZONES=1`) that runs
  today's single-thread path, so the game works at every step and the test suite runs both ways.
- **Start with P0** (it is also an urgent fix for the live server: spread 500 is over the tick budget today) and the
  P1 gateway, which takes the single biggest slice of CPU off the simulation without touching gameplay code.

## 1. Measurements

### 1.1 Method

`pnpm netload --bots 500 --scenario town|spread --duration 60 --warmup 20 --prof <dir>` (docs/NETWORK_AUDIT.md §7) on
master `9152c71`, under `C:\dev\BENCH.lock`, ≥ 5 GB free RAM. Dev PC: Ryzen 5 9600X (6C/12T), 16 GB, Windows 11,
Node 24.21. Server tick 10 Hz (budget 100 ms), interest pass every 200 ms (`INTEREST_MS`), crowd cap 100. The server's
V8 CPU profile (`--cpu-prof`) was cut to the 60 s measuring window and every sample attributed by its call stack
(outermost frame = phase, the frame under the tick = subsystem; an ad-hoc script, not committed — P0 replaces it
with built-in per-phase timers).
Percentages are of the server's busy CPU; ms are per tick (597 town / 574 spread ticks in the window; the socket flush and
inbound work between ticks is divided the same way). Caveats: the profiler adds overhead (profile busy 38 / 63 % vs
43 / 49 % by `process.cpuUsage`); Windows loopback `writev` is dearer than Linux; the live N100 is roughly 2–3×
slower per core than this Ryzen (estimate, not measured), so live costs are ~2–3× the ms below.

| Run | Tick p50 / p95 / p99 / max (ms) | Server CPU | Out | Out / player | Msgs / player / s | RTT p50 / p95 | RSS idle / max |
|---|---|---|---|---|---|---|---|
| town 500 | 8.0 / 43.6 / 48.2 / 57 | 43 % | 1.94 MB/s | 3.9 kB/s | 35.6 | 2 / 38 ms | 672 / 837 MB |
| **spread 500** (50 places) | **43.5 / 103 / 161 / 343** | 49 % | 0.46 MB/s | 0.9 kB/s | 8.6 | 12 / **101** ms | 671 MB |

No disconnects, no drops. **Spread 500 is over the tick budget at p95** — on 2026-10-10 the same scenario measured
18 / 23.6 ms (NETWORK_AUDIT §7). Not bisected; the profile puts all of the growth in the monster AI's all-player scan
(below), most likely more awake monsters near the GM places (now 50) and the Climb's nests.

### 1.2 Where one tick goes

| Subsystem (code) | Town 500 ms / % | Spread 500 ms / % |
|---|---|---|
| Monster AI — `ai.ts thinkMob` → `Gameplay.playersNear` → `World.playersNear`: every awake mob scans **every player** (+ `positionAt` each) | ≈ 0 | **24.2 / 37.0 %** |
| Mob loop — `Gameplay.tick`: idle-mob wake check `active.some(...)` over **every player**, regen, corpses, item expiry | 4.7 / 12.0 % | **10.1 / 15.4 %** |
| AoI interest pass — `World.interestPass/reveal/inRange/refreshViewer` (grid, range, visibility) | **12.6 / 32.6 %** | 8.7 / 13.2 % |
| Crowd cap — `World.pickCrowd/crowded` | **4.0 / 10.3 %** | 0.3 / 0.4 % |
| Spawn/despawn build + send (`state()`, decorators) | 0.4 / 1.0 % | 0.5 / 0.7 % |
| Movement — arrivals (`World.arrive` → `stop`), `World.tick` bookkeeping | 0.2 / 0.4 % | 2.4 / 3.7 % |
| Inbound `moveTo` — `World.moveTo/walkEntity` (nav chord + `move` broadcast) | 0.8 / 1.9 % | 1.8 / 2.7 % |
| Inbound other — parse/validate/rate limits (`validate.ts`, `Connection.onFrame`), gameplay requests | 0.2 / 0.4 % | 0.9 / 1.4 % |
| Combat/skills — auto-attack, `skills/engine.ts`, `mob-skills.ts` | 0.2 / 0.4 % | 1.3 / 2.0 % |
| Pathfinding/nav — `MeshNav` chords (inside the AI and `moveTo` rows) | 0.06 / 0.2 % | 0.6 / 1.0 % |
| Chat — `World.sayLocal` (range-limited) | 0.2 / 0.5 % | 0.2 / 0.3 % |
| Timers/jobs/events — all other module `tick`/`tickPlayer` hooks (weather, storm, siege, jobs, winter, quests, Climb…) | 0.4 / 0.9 % | 1.3 / 2.0 % |
| Encode — `JSON.stringify` **once per recipient** in `Connection.send` (work kind, overlaps rows above) | 0.7 / 1.8 % | 0.9 / 1.4 % |
| **Socket flush** — `corkTurn` → `uncork` → `writev` + `ws` framing (between ticks) | **14.3 / 37.0 %** | **10.9 / 16.7 %** |
| DB saves — periodic `persist` (`SAVE_INTERVAL` 30 s, one transaction) | 0.02 / 0.04 % | 0.05 / 0.07 % |
| GC | 0.2 / 0.5 % | 1.0 / 1.5 % |
| **Busy per 100 ms interval** | **38.5 ms** | **62.6 ms** |

Top self time, spread: `World.playersNear` 15.9 %, `writev` 15.3 %, `Gameplay.tick` (wake check) 13.3 %,
`World.positionAt` 10.7 %, `Gameplay.playersNear` filter 8.5 %, `interestPass` 7.1 %. Town: `writev` 34.2 %,
`Gameplay.tick` 11.6 %, `reveal` 10.1 %, `inRange` 9.3 %, `pickCrowd` 8.1 %, `interestPass` 5.7 %.

### 1.3 What the numbers say

- **F1 — O(mobs × players) scans are the #1 cost and grow with N².** `World.playersNear`, the wake check, and also
  `broadcastAbout`/`broadcastAboutEither` (every event scans every player, R4) do not use the interest grid. They
  would stay O(N²) inside one zone after sharding, so they are fixed first (P0), not parallelised.
- **F2 — Socket writes are 17–37 % and scale with connections × messages**, not with the simulation. They are the
  cleanest thing to move off the simulation thread (gateways, P1). `JSON.stringify` runs once per recipient: a
  `move` seen by 100 viewers is encoded 100 times.
- **F3 — The AoI pass is 44 % in a crowd** (500 × 500 candidate pairs every 200 ms; the p95 ticks are the interest
  ticks). It is per-viewer independent work over a position snapshot: ideal for job workers (P1b).
- **F4 — Gameplay modules are cheap.** Sharding is needed for cores, not because a module is slow: after P0 + P1 one
  simulation thread on this PC is estimated at ~1,500 spread players, ~600 on the N100; 2,000+ with headroom (flight
  and swim physics at 20 Hz, sea AI, siege armies) needs the simulation itself on several cores (P3).
- **F5 — DB, chat, nav, timers/events are each < 1 %.** The DB writer (P2) is for latency isolation and crash-safe
  ordering under sharding, not for throughput.
- **F6 — Memory: 672 MB RSS idle per world instance** (content + navmesh + module state). Z zone workers must not each
  load a copy: the navmesh goes into SharedArrayBuffer-backed typed arrays (one copy for all threads) and each zone
  loads only its cells' nests/NPCs. P0 measures the split (nav vs content vs modules).

## 2. Where we are

| Concern | Today (master) |
|---|---|
| Process | One Node process: `main.ts` → `game.ts startServer`: HTTP (static, REST, admin API), `ws` WebSocket server, one `World`, one `Gameplay`, `better-sqlite3` |
| Loop | `World.start` `setInterval` at `TICK_HZ` (10 live): `arrive` moves → `Gameplay.tick` (players, mob AI, items, spawner, module `tick` hooks) → `updateInterest` every 200 ms |
| Entities | `World.players/mobs/items/npcs/cos` maps; ids from `World.newId()` (one counter) |
| Movement | Event-driven segments (`from, to, speed, startedAt` in server time); `positionAt(now)`; straight nav chords (`MeshNav.walk`), no server A* |
| Interest | Uniform 120 m grid per pass, spawn < 120 m / despawn > 130 m, crowd cap 100 (`pickCrowd`), must-see rules |
| Connections | `connection.ts`: auth (sha256 session token), state machine, `validate.ts`, per-type budgets, flood ceiling, strikes; `send` = stringify + corked `ws.send` |
| Persistence | `db.ts`: WAL, `synchronous=NORMAL`, **synchronous** transactions on the game thread; inventory is DB-authoritative (`inventoryTx` loads, mutates an `InvDraft`, writes touched slots), two-character `pairTx` (trade, stall); 46 files use the store (`this.g.store` 122×) |
| Modules | ~45 `GameplayModule`s (`modules.ts`): hooks `enter/moved/stopped/tickPlayer/tick/playerDied/warped/inventoryChanged/mobDied/forget/gate`, direct references between modules (`this.g.law`, `this.g.jobs`…), 34 files scan `world.players` directly |
| Failure | `resume.ts` holds a body 15 s for a reconnect; tick errors caught and logged; graceful `close()` saves everything |
| Private build | `FlightService` (`flyInput` 20/s, fixed-step physics, `flyAck` per tick, distance-tiered `fly`), `CourtService` (Drowned Court: `swimInput`, 3D swim, sea-monster 3D AI, wading, storm currents), `CostumeService` (appearance), `WalkService` (speed factor) |

## 3. Target architecture

### 3.1 Picture

```
 browsers ──WS──▶ [gateway proc 1..G]  sockets, hello/auth, decode+validate, budgets, strikes, heartbeat,
                        ▲   │            encode-once fan-out, cork/backpressure, per-conn routing table
       HTTP (static,    │   │ IpcTransport (batched, binary out-batches)
       REST, admin) ──▶ [core process] ─────────────────────────────────────────────────────────────────┐
                        │  main thread: director (cell→worker map, id blocks, lifecycle, metrics, routing),│
                        │               HTTP/REST/admin, global services (accounts, chat channels, party, │
                        │               guild, economy, law/jail, events/weather/clock, news)             │
                        │  zone worker 1..Z (threads): World+Gameplay over owned cells, ghosts, handoff     │
                        │  job workers 1..J (threads): AoI/crowd selection, nav queries, AI batches (SAB)  │
                        │  db writer (thread): SQLite WAL single writer, journal, group commit, transfers  │
                        └── PortTransport (MessagePort + transferables) between threads ───────────────────┘
```

Typical placement: 8 cores = 2 gateways, 4 zones, 2 job threads, core + DB writer; 4 cores (N100) = 1 gateway,
2 zones, 1 job thread, core + DB writer. One systemd unit as today (the gateways are children of the core).

### 3.2 Threads, processes, transport

- **Gateways are processes**, everything else threads in the core process. Node cannot hand a socket to a
  `worker_thread`; it can hand one to a child process (`subprocess.send(msg, socket)`, what `cluster` does). The
  core's HTTP server keeps static/REST/admin unchanged and, on a WS `upgrade` to `/ws`, does the origin check and
  the per-IP cap, pauses the socket and passes it (with `head` and the request headers) to the least-loaded gateway,
  which completes the handshake (`wss.handleUpgrade`). Works on Windows (dev) and Linux, isolates a gateway crash,
  and the gateway↔core link is already a byte stream (multi-machine ready). TLS stays in front of Node
  (Tailscale serve / Caddy), never in the core. (Alternative kept in reserve: gateway threads with Node 24's
  `listen({ reusePort: true })` — Linux only; verified `ENOTSUP` on Windows.)
- **Zones, jobs, services, DB writer are threads**: shared read-only memory (navmesh in SharedArrayBuffer), cheap
  MessagePorts, ArrayBuffer transfer for bulk.
- **One `Transport` interface** so placement is configuration (P4 adds TCP):

```ts
// apps/server/src/bus/transport.ts
export type Address = `gw:${number}` | `zone:${number}` | `job:${number}` | `svc:${string}` | 'db' | 'director'
export interface Envelope { to: Address; from: Address; k: string; id?: number; re?: number; tick?: number; body?: unknown; bin?: ArrayBuffer }
export interface Transport {
  send(e: Envelope, transfer?: ArrayBuffer[]): void            // fire-and-forget, FIFO per (from, to)
  request<T>(e: Omit<Envelope, 'id'>, timeoutMs?: number): Promise<T>
  on(k: string, h: (e: Envelope) => unknown): void
  stats(): { queued: number; oldestMs: number; sentPerS: number; recvPerS: number }
}
// PortTransport (MessagePort), IpcTransport (child_process channel, 'advanced' serialization), TcpTransport (P4)
```

Guarantees: FIFO per (sender, receiver) pair only; no ordering across pairs (handoff fences, §3.4, handle the one
place that matters). Messages are typed unions in `bus/messages.ts`, versioned with the build.

### 3.3 Gateway layer

Moves out of `connection.ts`/`game.ts` into `apps/server/src/gateway/` (same code, new home):

- **Connection lifecycle:** heartbeat ping/pong 30 s, 5 s hello timeout, close codes (`CLOSE_CODE.*` unchanged),
  disconnect logging (N8), `slow` 4011 at > 1 MiB unsent.
- **Auth:** `hello` token → sha256 → session lookup on a read-only SQLite connection (WAL readers never block the
  writer); duplicate login → `replaced` (4000) via the director's account→connection map (one account, one socket,
  across gateways). Lobby requests (`charList/charCreate/charLook/charDelete/nameCheck`) → `svc:account`.
- **Decode/validate:** `parseClientMessage` (validate.ts, exact key sets), the 60/s flood ceiling, the silent
  budgets (`moveTo`, `ping`, `flyInput`, `swimInput`, lobby), chat and GM buckets, strikes → 4008. **Answered**
  budgets (`CLIENT_RATE_LIMITS` → `actionResult rate_limited`) stay in the zone: the ack contract is "one
  `actionResult` per request, FIFO per type", and only the zone can keep that order.
- **Routing:** `conn → zone address` (set by the director on enter, handoff, leave); inbound frames batched per
  event-loop turn per destination as `{conn, seq, msg}`; while a connection is in handoff its frames are held and
  released to the new owner in order.
- **Outbound:** zones send one binary **out-batch** per turn per gateway:
  `u32 count, { u32 len, utf8 JSON payload, u16 n, u32 conn × n } × count` — each message **encoded once**, fanned
  out by the gateway (today: stringified per recipient). The gateway corks per turn (N1), writes, enforces
  backpressure, counts `NetStats` per type. Global notices (`notifyAll`) are one record with `n = 0xFFFF` = "every
  in-world connection of this gateway".
- **Protocol is unchanged** (JSON text frames, `PROTOCOL_VERSION` as is). Binary encoding (R2) can be added later
  in the gateway alone.

### 3.4 Simulation layer: cells, zones, workers

**Cells.** The unit of ownership is a **cell** = one navmesh region of the export (`NVM_REGION_SIZE`, 1920 SRO units
≈ 192 m), plus **instance cells** for places with their own rules (jail, stockade, tomb dungeon, the private Drowned
Court). A **zone** is a named group of cells used for the initial layout and for pinning; a **zone worker** owns
any set of cells. Initial layout (P3): Jangan town (walls + plaza), fields W/E (and the Climb high country),
beaches/sea (coast, hot springs), Drowned Court (private, its own worker: 3D swim physics + sea AI at 20 Hz),
instances (jail, stockade, tomb). The director keeps `cell → worker` and can move cells (§3.4 load balancing).

**Ownership.** Every entity has exactly one owner worker = the owner of the cell it stands in, with exceptions:
monsters belong to their **nest's cell** for life (a mob chasing past its cell stays owned and is published as a
ghost wherever it stands); siege army
monsters, caravans/transports (`jobs/transport.ts`), horses with riders and a piloted boss migrate like players.
Entity ids stay globally unique: the director hands out id blocks (65,536 at a time) to each worker instead of
`World.newId()`'s single counter; the client sees ordinary ids.

**Per-zone tick.** Each worker runs `World.tick` at `TICK_HZ` on a shared epoch (tick k at `epoch + k/TICK_HZ`,
same `Date.now()` clock — one machine). Requests are still applied on arrival (as today; deferring them to the tick
would add up to 100 ms to every click), in per-connection FIFO order. Cross-worker messages carry the sender's tick
and are applied at the next tick start in (tick, sender, seq) order. The RNG is per zone (`config.rng` is already
injectable). Same inputs in the same order → same result: a zone can be replayed from its input log for debugging.

**Handoff (fenced).** When an owned mover's `positionAt(now)` is ≥ 16 m inside a cell of another worker (or a warp
lands there: town scroll, GM tp, court entry, jail):

1. Owner A tells the gateways to **hold** the player's inbound; A finishes the player's in-flight work (pending
   commit-then-ack answers complete or travel with the state).
2. A serialises a `PlayerSnapshot`: the save row (as `persist`), the live move segment, `known`, crowd, foes, the
   module states via two new hooks `export?(p): unknown` / `import?(p, data)` on `GameplayModule` (skills
   cooldowns/buffs/actions, quests runtime, posture, mounts, berserk, Climb linger, flight `Flyer`, court `Swimmer`,
   stamina/breath, walk factor, costume look) and the journal sequence (§3.8).
3. A sends its last out-batches, then a **fence(E, n)** to every gateway; B imports E (same id, same segment), B's
   messages about E are queued until every gateway has acked the fence (in-process: < 1 ms). This is the only
   ordering problem of multiple senders, and the fence solves it: the client never sees B's `move` before A's `stop`.
4. The director re-routes the connection to B; held frames flow to B; A keeps E as a ghost. No client message, no
   visible effect. B not acking within 2 s → A keeps E and retries later. Anti ping-pong: no hand-back within 5 s
   unless ≥ 32 m deep. Handoffs are server-initiated only.

**Ghosts and cross-border play.** Every worker publishes to each neighbour, every tick, the entities of its cells
within the **border band** = view range + hysteresis = 130 m (also ≥ aggro sight, area skills, chat range):
`{id, kind, segment|pos, yaw, flags (dead, invisible, staff, veil, cape, wanted, jailed), partyId, guildId, conn,
stateVersion}` plus the full `EntityState` when the version changes (equipment, costume). Rules:

| Interaction | Rule |
|---|---|
| Who sends what about entity E | **Always E's owner**, to E's watchers (local and remote connections). A viewer's zone decides *whether* V sees E (interest + crowd cap on ghosts) and sends `watch(E,V)` / `unwatch(E,V)`; the owner then sends `spawn` / `despawn` itself, so every message about E reaches V in order |
| Melee/skill on a ghost | The attacker's zone checks its own side (cooldown, mana, range on ghost data) and sends `hit(E, attacker snapshot, skill, now)` to E's owner, which re-checks range on its authoritative position, applies damage/death/loot and broadcasts. **The owner of the affected entity decides** |
| Area skills, lightning, kegs, tornado | The caster's zone computes the area; local victims are hit locally, ghost victims get one `hit` each at their owner |
| Monster aggro across a border | A mob may target a ghost player (band); its attacks are `hit`s to the player's owner |
| XP/party share, loot owner | The mob's owner computes shares over local + ghost party members (`partyId` on the ghost) and sends `grantExp` to their owners; ground loot is created in the mob's cell |
| Pickup of an item across a border | `take(item)` to the item's owner (removes once, request id) → the item travels in the reply into the picker's journal |
| Local chat | Local delivery + `sayLocal(pos, msg)` to the neighbours within 120 m of the speaker; they deliver to their players in range |
| Trade/exchange between two zones | Economy service (§3.6) + escrow + one DB transaction (§3.8); zones only lock, escrow and apply |
| Must-see (party, guild, foes, targets) | Evaluated by the viewer's zone from ghost fields and its own foe memory; foes noted on `hit` both ways |

**Load balancing.** Workers report per-cell cost (entities × measured tick share) every 5 s. When a worker's tick
p95 stays > 50 % of the budget and another is < 25 %, the director moves a border cell set from the hot to the cold
worker: freeze the cells for one tick, batch-handoff all their entities (mobs, items, NPCs included), re-route, swap
ghost roles. At most one move per worker per minute. **Pinning:** an event can pin cells together (the siege pins
Jangan town and its approaches to one worker while it runs, so the army fight never crosses workers). Limit: one
cell's crowd (1,000 at the plaza fountain) cannot be split — it relies on the AoI job workers, the crowd cap and
encode-once.

**Module classes** (what changes per module in P2/P3):

| Class | Modules | Change |
|---|---|---|
| Zone-local | world core (moves, AoI), `skills`, `mobSkills`, `posture`, `berserk`, `durability`, `repairs`, `alchemy`, `rarity`, `itemUses`, `npcs`/`shops`/`storage` (NPC-bound), `mounts`, `movement`, `roles`, `uniques` (runtime), `pilot`, `winterPlay` parts, `walls`/`wallRepair`/`wallLooters`/`siege` battle/`kegs` (town zone), `transports`/`robbery`, private `flight`, `court`, `costume`, `walk` | Global `world.players` scans → `playersNear` (grid + ghosts), watchers, or `notifyAll` |
| Player state that travels | `quests`, `climbRewards`, `climbPlaces`, `penalty` (linger), skills cooldowns/buffs, flight stamina, swim breath, job licence/rank of the player | `export`/`import` hooks |
| Global service (one owner) + zone proxy | `party`, `guilds`, `trade`, stall purchases, `market`, `jobs` core (rankings, prices), `law` (Wanted list), `hunters` (duty roster), `jail` (sentences; the jail is an instance cell), `caravan` and `siege` schedules, `uniques` schedule/notices, `weather`/`winter`/`lightning`/`storm`/`tornado`/`clock` (global schedule, effects applied by the zone owning the cells, seeded per storm+cell), chat channels, accounts/sessions, news, admin/GM | Replicated fields on `Player` (`partyId`, `guildId`, `wanted`, `jailedUntil`, `duty`…) for synchronous reads; writes are bus requests |

**Private modules.** Flight: `flyInput` routes like any frame; `flyAck` and the distance-tiered `fly` go to
watchers (they already filter by `known`); flyers cross cells fast, so their handoff hysteresis is 32 m and the
`Flyer` (body, input, seq, sim time) is in the snapshot; AoI stays 2D. Drowned Court: its own zone worker and
instance cells, entered by warp (= handoff with a new position); its `currents` read the global storm schedule;
the sea monsters stay inside it. Costume/walk: player state, in the snapshot and in ghost `EntityState`.

### 3.5 Compute offload (job workers)

- **AoI + crowd selection (P1b).** Per interest pass the zone writes a snapshot into a SharedArrayBuffer: per entity
  `id, x, z, kind, flags`; per viewer anchor (`viewFrom`), staff/veil flags, must-see id list, current `known` and
  crowd. J job workers each take a slice of the viewers and write the wanted visible set as `spawn[]`/`despawn[]`
  id lists; the zone applies them on its next tick (builds `state()`, sends). Interest already runs every 200 ms,
  so one tick of extra delay is invisible. Moves 14–44 % of the zone's CPU off its thread. Also the place to make
  the pass incremental (skip viewer/cell pairs where nothing crossed a cell since the last pass).
- **Nav queries.** The server walks straight chords (0.2–1 % CPU); no offload needed now. The navmesh moves to
  SharedArrayBuffer-backed arrays (one copy for every thread, F6); a future server A* (siege armies) runs here.
- **AI batches.** After P0 the AI is cheap; heavy batches (siege army steering, sea-monster 3D AI, flight/swim
  stepping for many bodies) can move to struct-of-arrays jobs later. Not needed for 2,000.
- **Password hashing.** scrypt for register/login already runs on the libuv pool (async); keep it off the core.

### 3.6 Global services

Each is a single owner (in the core's main thread at first, movable to its own thread), with a typed bus API and a
cached zone-side proxy:

| Service | Owns | Zones see |
|---|---|---|
| `svc:account` | accounts, sessions, character list/create/delete, login → zone placement | — |
| `svc:chat` | global/guild/party/whisper/system/GM channels, mutes | `chat` requests forwarded; local chat stays in zones |
| `svc:party`, `svc:guild` | membership, invites, leaders, guild storage (transfer semantics) | `partyId`/`guildId` on Player, kill-share rules |
| `svc:economy` | trade sessions, stall purchases, market (jobs), item mall later | escrow lock/apply requests |
| `svc:law` | Wanted list, bounties, Hunter duty roster, jail sentences | `wanted`, `duty`, `jailedUntil` on Player; capture → jail handoff |
| `svc:world` | clock, weather/storm/winter/tornado schedules, caravan/siege/unique schedules, notices | state pushes (`worldClock`, `weather` …) via `notifyAll` |

Global player scans become one of: `notifyAll(msg)` (gateways fan out), `playersNear` (zone grid + ghosts), or a
directory lookup (`byName` → director's name → worker map).

### 3.7 Internal bus (operational rules)

- Bounded queues: every port reports depth and oldest age; > 500 ms oldest = alert; out-batches are never dropped
  (they are events, N7) — a gateway that cannot keep up closes the slow client (4011) instead.
- Requests carry an id and a timeout; economy requests carry an **idempotency key** (retry-safe).
- Bulk data (out-batches, AoI snapshots, ghost deltas) are ArrayBuffers (transferred or SAB), never structured-cloned
  objects.

### 3.8 Persistence

**One DB writer thread** (`apps/server/src/db/writer.ts`, better-sqlite3, WAL, `synchronous=NORMAL` as today).
Everyone else has read-only connections (WAL readers never block it).

- **Ownership rule.** Character-owned state (inventory, gold, equipment, storage of the online character, skills,
  quests, flight/swim state) has exactly **one live owner**: the zone simulating the character, or the economy
  service while it holds an escrow. The owner mutates its in-memory copy and appends **ops** to the writer.
  `InvDraft` already computes the diff (touched slots + gold), so `inventoryTx` becomes "apply to the cached
  inventory, journal the touched slots' new contents".
- **Ops are ordered, idempotent row sets** with a per-character sequence number:
  `charSave` (position/HP/MP; coalescable, last wins), `slots` (touched slots' full new contents + gold),
  `kv` (quests, skills, flight…), `transfer` (two characters, one transaction), `log` (social/audit rows).
  The writer applies them in seq order per character (a gap holds that character's ops up to 1 s, then alerts) with
  **group commit**: one `BEGIN IMMEDIATE … COMMIT` every ≤ 10 ms or 500 ops, one SAVEPOINT per op.
- **Transfers (no dupes, no loss).** Trade, stall purchase, guild storage, market, item mall, GM grants:
  1. The economy service asks each side's owner to **escrow**: lock the inventory (the trade gate already does),
     flush its journal up to seq S, report the offered slots and gold.
  2. The service sends one `transfer` op (both diffs + the `social_log` row, as `pairTx` today); the writer applies
     everything ≤ S for both characters first, re-checks the escrowed contents against the DB, commits atomically.
  3. Only after the commit reply do the owners apply the result to memory, unlock and send the `actionResult`
     (**commit-then-ack**). A crash anywhere leaves the DB with either the whole transfer or none of it, and a
     restarted zone reloads from the DB.
- **Single-character ops** (move slot, potion, loot pickup, NPC buy/sell — no counterparty) answer at once; the op
  reaches the DB within one group commit. A zone crash can lose that window (≤ 10 ms) but never duplicate: the item
  and its price are in the same `slots` op.
- **Barriers.** Logout, resume-hold release, handoff to another machine (P4) and shutdown wait for the writer's ack of
  the character's last seq, so a quick relog always reads the final state.
- **Shutdown order:** gateways stop reading → zones flush (Climb lingers, holds, players, walls) → services flush →
  writer drains, checkpoints, closes.

### 3.9 Authority, anti-cheat, protocol

Unchanged: clients send intents, the server pathfinds and simulates; positions, combat, items and prices are
server-side; `validate.ts`, budgets, strikes, origin check, per-IP caps and the abuse suites stay valid (the gateway
runs the same parser and limits; zones keep the answered limits and all gameplay checks). New internal rules:
cross-zone `hit`/`take` are re-validated by the owner; handoff and ghosts are server-only. **Client changes: none.**
`PROTOCOL_VERSION` unchanged; entity ids, message types and ordering per entity are preserved (fences). Optional
later: a zone restart could re-snapshot in place if the client accepts a second `worldEnter` (to check in
`apps/game/src/hud/index.ts` and the other `worldEnter` handlers); until then a restart uses the reconnect path below.

### 3.10 Failure handling

| Failure | Detection | Recovery | Players see |
|---|---|---|---|
| Zone worker crash/hang | `exit`/`error` event; watchdog: no tick heartbeat for 3 s → `terminate()` | Director marks its cells down, restarts a worker for them (static content, walls from DB), gateways close the affected sockets with the non-fatal `slow` 4011 | Auto-reconnect (resume path, 15 s grace) back where the DB has them; ≤ 10 ms of single-character ops lost, transfers whole or absent |
| Gateway crash | child `exit` | Director respawns it; zones treat its players as dropped sockets → `BodyHolds` (resume.ts) | Reconnect within the 15 s grace, body held in place |
| Service crash | thread `exit` | Restart from DB; zones re-register their players (party/guild ids); open trades cancelled, escrows released | Parties re-formed from the zones' cached ids or disbanded with a notice |
| DB writer crash | thread `exit` | Fatal by design: graceful stop of everything, supervisor restart (`RESTART_EXIT_CODE`); SQLite WAL keeps every committed op | Reconnect after the restart |
| Shutdown / update | SIGTERM, admin restart, updater | Order of §3.8; 10 s force timer as today | "The server is shutting down." |

### 3.11 Observability

- Per zone: tick p50/p95/max and the per-phase split of §1.2 (always-on `performance.now()` timers, P0), entities by
  kind, owned cells, ghosts in/out, handoffs/s and failures, inbox depth and oldest age, out msgs/s and bytes/s.
- Per gateway: connections, in/out msgs/s and bytes by type (today's `NetStats`), rate-limit drops, strikes,
  backpressure closes, event-loop delay (`perf_hooks.monitorEventLoopDelay`).
- Services: queue depth, request p95. DB writer: queue depth, group size, commit p50/p95, WAL size, checkpoint ms.
- The director merges them every second: `GET /netstats` (extended, loopback + `NET_STATS=1` as today) and an admin
  page **Server** (`apps/admin/src/pages/server.ts`, `GET /api/admin/server` in `apps/server/src/admin/ops.ts`):
  workers table, 60 s sparklines, cell map coloured by tick cost. Log alerts: tick p95 > 50 % budget for 60 s, inbox
  age > 500 ms, writer queue > 5,000 ops or commit p95 > 50 ms.

## 4. Migration plan

Every phase ships to the live server only after the full test suite and the netload gates below, and keeps an off
switch: `GATEWAYS=0` (in-process connections, today's path), `AOI_JOBS=0`, `DB_WRITER=0` (synchronous store),
`ZONES=1` (one zone worker owning every cell = today's World). Tests run in both modes in CI.

| Phase | Content | Effort | Main risks | Netload gate |
|---|---|---|---|---|
| **P0** measure + O(N²) | Per-phase tick timers in `NetStats`/admin dashboard; one player grid per tick reused by `playersNear`, the wake check and `sayLocal`; `watchers` index (inverse of `known`) for `broadcastAbout*`; encode once per message object per turn; P0 memory split (nav/content/modules) | 2–3 days | Low: behaviour must stay identical (same recipients, same order) — existing tests + a recipient-equivalence test | spread 500 p95 ≤ 30 ms (from 103), town 500 p95 ≤ 40 ms, same msg mix |
| **P1a** gateway processes | `bus/` (Transport, IpcTransport), `gateway/` (lifecycle, auth, validate, budgets, out-batches, fan-out), upgrade-socket passing, director routing table, `/netstats` merge | 6–8 days | Handle passing edge cases (`head` bytes, Windows), duplicate-login across gateways, ack FIFO (answered budgets stay in the zone) | town 500: core CPU −30 % or more, RTT p95 ≤ 40 ms; 1,000 spread + 500 town on the dev PC within budget |
| **P1b** AoI job workers | SAB snapshot, job pool, apply diffs; incremental pass | 3–4 days | Visibility rules (staff, veil, invisible, Play the Boss anchor, must-see) must match exactly: run old and new pass side by side in tests and diff | town 500 tick p95 ≤ 15 ms; town 1,000 within budget |
| **P2** DB writer + services | Writer thread, ops/journal/group commit, cached inventories, `transfer` + escrow + commit-then-ack, barriers; services behind bus APIs with zone proxies; global scans → `notifyAll`/grid/directory | 10–15 days | **Economy** (dupes/loss): abuse suites + a new invariant test (total gold + items constant under random trades with crash injection); 46 files on the store | `econ` scenario 0 invariant violations, incl. `kill -9` mid-trade; latency of answered requests p95 ≤ 20 ms |
| **P3** zone sharding | Cells, `ZoneWorld`, id blocks, ghosts, watch/unwatch, `hit`/`take`/`grantExp`, fenced handoff, module `export/import`, layout of §3.4, zone crash restart | 20–30 days | Cross-border combat and quests edge cases, ordering, memory per worker (F6), private-branch merge (flight/court) | `border` scenario (bots walk across borders, fight on them): 0 desyncs (client-side segment check), 0 errors; 2,000 spread + 500 town on 8 cores, every zone p95 ≤ 50 ms; `chaos`: kill a zone → all its bots back ≤ 5 s, invariants hold |
| **P4** rebalance + multi-machine | Cell migration with hysteresis, pinning; TcpTransport, remote gateways, node registry, clock offset per node; DB stays on the core host | 8–12 days | Migration storms; clock skew across hosts | Hot-spot scenario (bots converge on one field): migration within 1 min, p95 back under 50 %; remote gateway on a 2nd box |

**Netload extensions** (`apps/server/src/cli/netload.ts`): `--procs N` (bots over several processes, for 2,000+),
scenarios `mixed` (town + spread), `border`, `econ` (trades/stall buys with a before/after gold+item ledger check),
`chaos` (kill a zone/gateway/service mid-run), `hotspot`; per-worker CPU profiles (`--prof` for every thread via
`inspector` sessions); the report adds per-zone tick percentiles from the extended `/netstats`. The final gate runs
on a 4–8 core Linux VPS (not the dev PC: Windows loopback and a shared machine distort socket costs).

## 5. Open questions and risks

- **Memory per zone worker** (F6): if content is a large share of the 672 MB, zone workers need shared or lazily
  loaded content tables, not just the navmesh in SAB. P0 measures it before P3 is sized.
- **One cell, one core:** a single plaza crowd beyond ~1,500 is bounded by one zone thread even with AoI jobs; the
  crowd cap and encode-once are the levers there (and binary encoding R2 in the gateway).
- **Quests and events spanning cells** (kill counts near a border, siege waves) are covered by "the owner of the
  affected entity decides" plus pinning; each module's border cases need a test in P3.
- **Spread regression (§1.1)** should be fixed in P0 regardless of the architecture: the live N100 cannot hold 500
  spread players today.

## 6. What to start with

P0 now: the per-phase timers (so every later step is measured the same way) and the three O(N²) fixes — they buy the
largest gain (spread 500: ~34 ms of a 63 ms interval is the monster AI and the wake check, mostly all-player scans), are low risk, and are needed inside every future
zone anyway. Then P1a (gateway processes, encode-once fan-out): the biggest remaining slice (17–37 %) leaves the
simulation thread with no gameplay change, and it creates the bus and the director that P2–P4 build on.

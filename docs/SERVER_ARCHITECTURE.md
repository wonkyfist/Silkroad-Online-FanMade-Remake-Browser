# Server architecture: the multi-core target (2026-10-12)

Status: design + measurements; **P0 and P1 built (2026-10-12, §4.1, §4.2)**, P2–P4 not yet. Scope: `apps/server` on master and the private branch's
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
- **P0 is done (2026-10-12, §4.1):** spread 500 tick p95 24.6 → 8.3 ms, town 500 43.0 → 16.6 ms, server CPU −55 % /
  −35 %, the same messages (a lockstep test proves identical decisions and streams); every change has an off switch.
- **P1 is done (2026-10-12, §4.2):** the client sockets live in gateway processes (`GATEWAYS`, default 1) and the
  interest pass's per-viewer work runs on AoI worker threads (`AOI_JOBS`, default 2). Town 500 tick p95 16.6 → 7.5 ms
  and the tick thread's CPU 24 → 5 % (the socket writes moved to the gateway, 17 % of a core); spread 1,000 p95
  14.0 → 9.3 ms. The same streams with the switches on and off (a scripted-client test for the gateway, the lockstep
  test for the workers); a gateway crash comes back through the reconnect grace.

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
| **P0** measure + O(N²) — **done 2026-10-12** (§4.1) | Per-phase tick timers in `NetStats`/admin dashboard; one player grid per tick reused by `playersNear`, the wake check and `sayLocal`; `watchers` index (inverse of `known`) for `broadcastAbout*`; encode once per message object per turn; P0 memory split (nav/content/modules) | 2–3 days | Low: behaviour must stay identical (same recipients, same order) — existing tests + a recipient-equivalence test | spread 500 p95 ≤ 30 ms (from 103), town 500 p95 ≤ 40 ms, same msg mix |
| **P1a** gateway processes — **done 2026-10-12** (§4.2) | `bus/` (Transport, IpcTransport), `gateway/` (lifecycle, auth, validate, budgets, out-batches, fan-out), upgrade-socket passing, director routing table, `/netstats` merge | 6–8 days | Handle passing edge cases (`head` bytes, Windows), duplicate-login across gateways, ack FIFO (answered budgets stay in the zone) | town 500: core CPU −30 % or more, RTT p95 ≤ 40 ms; 1,000 spread + 500 town on the dev PC within budget |
| **P1b** AoI job workers — **done 2026-10-12** (§4.2) | SAB snapshot, job pool, apply diffs; incremental pass | 3–4 days | Visibility rules (staff, veil, invisible, Play the Boss anchor, must-see) must match exactly: run old and new pass side by side in tests and diff | town 500 tick p95 ≤ 15 ms; town 1,000 within budget |
| **P2** DB writer + services | Writer thread, ops/journal/group commit, cached inventories, `transfer` + escrow + commit-then-ack, barriers; services behind bus APIs with zone proxies; global scans → `notifyAll`/grid/directory | 10–15 days | **Economy** (dupes/loss): abuse suites + a new invariant test (total gold + items constant under random trades with crash injection); 46 files on the store | `econ` scenario 0 invariant violations, incl. `kill -9` mid-trade; latency of answered requests p95 ≤ 20 ms |
| **P3** zone sharding | Cells, `ZoneWorld`, id blocks, ghosts, watch/unwatch, `hit`/`take`/`grantExp`, fenced handoff, module `export/import`, layout of §3.4, zone crash restart | 20–30 days | Cross-border combat and quests edge cases, ordering, memory per worker (F6), private-branch merge (flight/court) | `border` scenario (bots walk across borders, fight on them): 0 desyncs (client-side segment check), 0 errors; 2,000 spread + 500 town on 8 cores, every zone p95 ≤ 50 ms; `chaos`: kill a zone → all its bots back ≤ 5 s, invariants hold |
| **P4** rebalance + multi-machine | Cell migration with hysteresis, pinning; TcpTransport, remote gateways, node registry, clock offset per node; DB stays on the core host | 8–12 days | Migration storms; clock skew across hosts | Hot-spot scenario (bots converge on one field): migration within 1 min, p95 back under 50 %; remote gateway on a 2nd box |

**Netload extensions** (`apps/server/src/cli/netload.ts`): `--procs N` (bots over several processes, for 2,000+),
scenarios `mixed` (town + spread), `border`, `econ` (trades/stall buys with a before/after gold+item ledger check),
`chaos` (kill a zone/gateway/service mid-run), `hotspot`; per-worker CPU profiles (`--prof` for every thread via
`inspector` sessions); the report adds per-zone tick percentiles from the extended `/netstats`. The final gate runs
on a 4–8 core Linux VPS (not the dev PC: Windows loopback and a shared machine distort socket costs).

### 4.1 P0 as built (2026-10-12)

Each change has its own switch (env, default on; off runs the path from before P0, to compare or roll back;
`pnpm netload` passes the environment to its server). `GET /netstats` shows which ran (`switches`).

| Switch | What | Code |
|---|---|---|
| `TICK_TIMERS` | Always-on phase timers, one sample per tick interval: `arrive`, `players` (actions, tickPlayer hooks), `mobs` (wake check, AI), `items`, `spawner`, `modules` (each module's tick hook timed too), `interest`, `crowd`, `inbound` (client frames between ticks), `flush` (end-of-turn writev), `save`, `gc`; messages/s and JSON encodes/s, the sockets' outbound backlog (`queue`), event-loop delay (`loop`) and the startup memory split. On `GET /netstats` (`phases`, `rates`, `queue`, `loop`, `switches`, `memory`), in the netload report and on the admin dashboard's **Performance** card | `phases.ts`, `netstats.ts`, `admin/api.ts perfTile`, `apps/admin/src/pages/dashboard.ts` |
| `MOB_GRID` | One player grid per monster pass on **region cells** (192 m on regionAt's axes, `cells.ts`: the cells a zone will own). The wake check reads it (the same arithmetic as the old `active.some`, so the same answer); every `playersNear` inside the pass (AI acquisition, mob skills, Climb roles, uniques…) takes candidates from the cells in reach (+2 m) and applies the old exact test to live positions, in `world.players` order. A warp, login or logout during the pass rebuilds the grid; outside the pass (requests, module hooks) the full scan runs as before. `sayLocal` keeps its scan: chat arrives between ticks, on live positions a tick's grid cannot answer exactly, and it is 0.2 % of the CPU | `cells.ts`, `World.beginPlayerScan/playersNear`, `Gameplay.tick` |
| `WATCHERS` | The recipient index: the inverse of `Player.known` (`known.ts`; `KnownSet` keeps it in step on every add/delete/clear, whoever calls them). `broadcastAbout`, `broadcastAboutEither` and the despawns of `removeEntity`/`remove` go to the watchers instead of scanning every player; `World.watchersOf(id)` for modules with their own send rules. Falls back to the scan if a player ever enters `world.players` without `World.add` | `known.ts`, `world.ts` |
| `ENCODE_ONCE` | A broadcast makes one `Encoded` (JSON + UTF-8 Buffer, on first use) that every recipient's connection writes (`Player.send(msg, enc)`); every frame goes to `ws` as a Buffer (text opcode), so a corked socket's writev holds only buffers and copies nothing; one `setImmediate` per turn uncorks every socket corked in it | `encode.ts`, `connection.ts` |
| `AOI_FAST` | The interest pass with the same spawns and despawns in the same order, minus its overhead: per-cell id/position arrays (no map lookup per candidate), numeric cell keys, no candidate copies, the crowd pick on the same arrays without sorting what it only reads the head of (`pickCrowdCells`, `firstSorted`), the crowd cap asked first in the reveal loop, and `alsoMustSee` as per-player keys (`alsoMustSeeKeys`: party, guild) instead of once per pair | `world.ts` |

**Same behaviour, tested.** `apps/server/test/p0-equivalence.test.ts` runs two worlds in lockstep, every switch on
against all off, through 300 ticks of fights, deaths, parties, staff viewers, a veiled boss whose pilot views from it,
warps, logins and logouts, invisibility, foes and chat: after every tick the monster states and every known set are
identical, and at the end every client's message stream is (each recipient's own order included). A 60-player
lattice (many equal distances) checks the crowd picks pass by pass. A deliberately broken grid, recipient set or tie
rule fails them at once. Unit checks pin the grid against full scans (cell edges, huge radii), the index against every
known set, encode-once (one encode for 12 recipients), the timers and the switches.

**Measurements** (§1.1's method without the profiler: 500 bots, 20 s warm-up, 60 s measured, tick 10 Hz; "off" = the
same build with `MOB_GRID WATCHERS ENCODE_ONCE AOI_FAST` off, i.e. the code paths of `354b437`; run back to back under
`C:\dev\BENCH.lock` on 2026-10-12, master `dfca8a2`; no disconnects, no bot errors, the same message mix):

| Run | Tick p50 / p95 / p99 / max (ms) | Server CPU | Out | Msgs / player / s | RTT p50 / p95 (ms) | JSON encodes / s |
|---|---|---|---|---|---|---|
| spread 500, P0 off | 18.9 / 24.6 / 28.1 / 34 | 24.8 % | 0.48 MB/s | 9.1 | 0.5 / 24.9 | 4,204 |
| **spread 500, P0 on** | **5.7 / 8.3 / 9.9 / 11** | **11.2 %** | 0.48 MB/s | 9.1 | 0.3 / 8.8 | 621 |
| town 500, P0 off | 9.6 / 43.0 / 46.2 / 53 | 37.6 % | 1.86 MB/s | 34.9 | 2.8 / 42.9 | 17,256 |
| **town 500, P0 on** (2 runs) | **13.0 / 16.9 / 18.4 / 20** and 2.8 / 16.3 / 18.4 / 20 | **23.8–24.9 %** | 1.87 MB/s | 35.0 | 0.7 / 16.8 | 1,300 |

Per phase, from the built-in timers (ms per 100 ms tick interval, mean / p95; `inbound` and `flush` run between ticks):

| Phase | spread off | spread on | town off | town on |
|---|---|---|---|---|
| mobs (wake check + AI) | 13.9 / 16.8 | 1.9 / 2.4 | 4.4 / 5.6 | 0.48 / 0.58 |
| interest | 3.3 / 7.0 | 2.0 / 4.4 | 12.3 / 26.0 | 5.5 / 12.1 |
| crowd | 0.19 / 0.41 | 0.13 / 0.28 | 5.2 / 11.2 | 1.3 / 2.8 |
| arrive | 0.92 | 0.54 | 0.81 | 0.47 |
| players, modules, spawner, items | 0.68 | 0.66 | 0.67 | 0.72 |
| inbound | 0.86 | 0.63 | 1.76 | 1.14 |
| flush (socket writes) | 4.9 / 7.0 | 4.7 / 6.7 | 14.6 / 23.7 | 15.4 / 25.1 |
| gc | 0.29 | 0.08 | 0.24 | 0.14 |
| **busy** | **25.1** | **10.5** | **39.9** | **25.2** |

- §1.1's spread baseline (43.5 / 103 ms) did not reproduce: the same build with P0 off measures 18.9 / 24.6 ms, and
  17.9 / 24.9 under `--prof` (as on 2026-10-10: 18 / 23.6), so that run was most likely slowed by other work on the
  PC. The town baseline does reproduce (43.0 ms p95; 44.3 under the profiler). P0's gate (spread p95 ≤ 30, town ≤ 40)
  and the targets (spread well under 50, crowded town under 30) hold either way.
- In town the p50 lands on either side of the interest ticks (every second tick): read the p95.
- The event-loop delay p99 fell from 39 to 24 ms (spread) and from 58 to 32 ms (town); the RTT p95 follows it.
- `flush` (one writev per connection and turn) stays about the same with P0 (the system calls cost, not the copies)
  and is now the largest single cost of a crowded town: P1a's target. The interest pass plus the crowd pick (O(N²)
  inside one crowd) is the next: P1b.

**Memory split (F6).** Measured at start with `node --expose-gc` (a GC before each sample; `GET /netstats memory`, and
the `memory by startup stage` log line): content tables +4 MB heap; world manifest + navmesh +10 MB heap and
75–120 MB of typed arrays (external); the ~45 modules +1 MB; 54 NPCs and 6,082 monsters +10 MB. The idle server holds
~50 MB of heap and ~80–105 MB external in ~430 MB RSS; the rest is the Node/V8 runtime, compiled code and allocator
slack. (The 672 MB "RSS idle" of §1.1 was read without a GC.) So the navmesh is the only large data set: zone workers
that share it through SharedArrayBuffer (§3.5) cost tens of MB each (their entities and module state), not hundreds.

**Private build** (the next merge of master into `C:\dev\jangan-private-wt`). A trial `git merge-file` of world.ts,
gameplay.ts, connection.ts and game.ts against the private versions merges without conflicts; the other P0 files are
unchanged on the private side. The private `if (m.sea) continue` stays in the monster loop (now in `Gameplay.tickAll`,
`tick` wraps it); `walkFactor`, `costumeHidden`, `Mob.sea`, the `flyInput`/`swimInput` cases and the content
installers are untouched. Kept APIs: `Player.known` is still a `Set<number>` to every reader (a `KnownSet`: its
`has/add/delete` keep the index right), `Player.send` takes an optional second argument (wrappers that forward only the
message stay correct, they just lose the shared encoding), `broadcastAbout`, `playersNear`, `positionAt` and
`world.players` are unchanged. Optional: `flight.ts broadcastFly` and `court.ts sendAbout` scan every player for
`known.has`; they can walk `world.watchersOf(id)` instead and send one `new Encoded(msg)` per sample
(`v.send(msg, enc)`). Flight and the Court assign `p.pos` directly, which the monster pass's grid tolerates as long as
it is not inside the monster loop (today: input handlers, tickPlayer, tick hooks — all outside it); a teleport of a
live player from inside it must go through `world.warp`. After the merge run `p0-equivalence.test.ts` (it builds the
private Gameplay, flight and Court included) and the flight and Court suites.

### 4.2 P1 as built (2026-10-12)

Two switches (env; a count, `off` = 0; `GET /netstats` `switches` shows which ran). Off runs the single-process path
of P0, unchanged. Tests and embedded servers default to off; `SRO_TEST_GATEWAYS=1 SRO_TEST_AOI_JOBS=2` runs any suite
with them on (the whole server suite passes both ways: 150 files, 1,691 tests).

| Switch | What | Code |
|---|---|---|
| `GATEWAYS` (default 1) | **P1a.** The core's HTTP server keeps static/REST/admin and, on a `/ws` upgrade, the origin check and the per-IP cap, then hands the raw socket (`subprocess.send(msg, socket)`, with the request headers and `head`) to the least loaded gateway process, which completes the handshake. The gateway runs the heartbeat, the flood ceiling, decode + validate and the silent budgets (`FrameGate`, the same code the in-process `Connection` runs) and forwards each frame's **verdict** in frame order; the core's `Connection` answers verdicts exactly as before (hello/auth, strikes, the answered budgets, lobby, every request). Outbound: one OUT frame per gateway and event-loop turn, records `{payload, n recipients}` (encode-once's Buffer merges consecutive sends) and closes in the same ordered stream; the gateway corks each socket for the batch, enforces `slow` 4011 at 1 MiB unsent and counts its own time. Transport: the child's IPC channel for the socket hand-off, two one-way pipes (fd 4 core → gateway, fd 5 back: a Windows pipe's pending read blocks writes on the same handle) with length-prefixed frames | `gateway/gate.ts` (FrameGate, verdicts), `gateway/protocol.ts` (frames, OutBatch), `gateway/hub.ts` (core side, `RemoteSocket`), `gateway/main.ts` (the process), `connection.ts` (`ConnSocket`: `WsConnSocket` in-process, `RemoteSocket` behind a gateway) |
| `AOI_JOBS` (default 2) | **P1b.** The interest pass (with `AOI_FAST` on, ≥ 48 players) writes a snapshot into SharedArrayBuffers — entities in `allEntities` order with positions, kind, hidden/veil flags, owner/pilot; the pass's grid; per viewer its anchor, staff flag, crowd state, known list (ids and entity indexes), foes, attack target and the must-see keys (party, guild) as small integers — and `aoi/kernel.ts` (interestPassFast's crowd pick, spawn and despawn decisions over typed arrays: the same tests, arithmetic and order; must-see as one stamped mark per viewer) runs on slices of the viewers: the tick thread takes the first, each worker one more; the tick thread waits (Atomics, ≤ 50 ms) and applies the decisions viewer by viewer in `world.players` order, so the spawns/despawns go out exactly as the in-thread pass sends them, in the same tick. A late, busy or dead worker costs only speed: its slice is computed on the tick thread and a dead worker is restarted. The workers load the kernel with Node's own type stripping (no loader) | `aoi/kernel.ts`, `aoi/pool.ts`, `aoi/worker.ts`, `World.interestPassJobs` |

**Same behaviour, tested.** `p1-gateway.test.ts`: the same scripted clients (a stranger refused, a hello timeout,
lobby, the charList budget, bad frames — not JSON, binary, unknown type, a stray key —, two players entering, seeing
each other, chatting, a refused gm frame, a 150-frame flood struck out with 4008, leaving) give **identical message
streams and close codes** with `GATEWAYS=0` and `1`; a killed gateway is restarted, its player is held and resumes
(same position); a shutdown reaches the clients (notice, then 4009); version and token refusals keep their codes;
the codec round-trips (records, order, frames split anywhere). `p0-equivalence.test.ts` gained the P1b lockstep:
worker threads against the tick thread over 300 ticks of fights, deaths, parties, staff, a veiled boss viewed from by
its pilot, warps, logins/logouts, invisibility, foes and player-vs-player targets — identical known sets, crowds
(insertion order included), monsters and every message stream; and the same with a worker killed mid-run. Removing any
must-see rule (target, targeted by, foes, keys) or shifting the crowd hysteresis in the kernel fails it.

**Measurements** (§4.1's method: 20 s warm-up, 60 s measured, tick 10 Hz; master `b8d5aac`, back to back under
`C:\dev\BENCH.lock` on 2026-10-12; "off" = `GATEWAYS=0 AOI_JOBS=0`, "on" = the defaults `GATEWAYS=1 AOI_JOBS=2`; P0
switches on in both; CPU in % of one core; no disconnects, no bot errors, the same message mix in every pair):

| Run | Tick p50 / p95 / p99 / max (ms) | Tick thread CPU | Core process CPU (all its threads) | Gateway CPU | All processes | RTT p50 / p95 / max (ms) | Tick-thread busy / 100 ms |
|---|---|---|---|---|---|---|---|
| spread 500, off | 6.2 / 7.9 / 8.8 / 9.8 | 9.9 % | 10.5 % | – | 10.5 % | 0.3 / 7.1 / 13 | 10.4 ms |
| **spread 500, on** | **4.5 / 6.3 / 7.3 / 10.4** | **5.2 %** | 6.7 % | 6.2 % | 12.9 % | 0.5 / 7.1 / 15 | **5.0 ms** |
| town 500, off | 12.9 / 16.6 / 18.5 / 20.5 | 24.1 % | 24.4 % | – | 24.4 % | 0.9 / 17.1 / 30 | 25.5 ms |
| **town 500, on** | **5.9 / 7.5 / 8.3 / 8.9** | **5.4 %** | 7.3 % | 16.9 % | 24.2 % | 1.0 / 9.5 / 18 | **5.3 ms** |
| spread 1,000, off | 11.3 / 14.0 / 17.1 / 19.2 | 21.3 % | 22.1 % | – | 22.1 % | 0.7 / 13.2 / 27 | 22.0 ms |
| **spread 1,000, on** | **7.1 / 9.3 / 10.6 / 12.2** | **7.3 %** | 9.3 % | 14.4 % | 23.7 % | 0.8 / 11.6 / 32 | **7.2 ms** |
| town 1,000, off | 36.7 / 43.8 / 46.3 / 48.2 | 55.9 % | 57.0 % | – | 57.0 % | 8.5 / 45.0 / 68 | 59.3 ms |
| **town 1,000, on** | **11.4 / 15.8 / 16.9 / 17.3** | **9.5 %** | 14.7 % | 40.6 % | 55.3 % | 4.9 / 20.8 / 34 | **10.4 ms** |
| town 500, `GATEWAYS=2` | 6.0 / 7.6 / 8.3 / 8.8 | 5.3 % | 7.2 % | 9.5 + 9.3 % | 26.0 % | 0.6 / 8.4 / 14 | 5.4 ms |

Per phase on the tick thread (ms per 100 ms interval, mean / p95), town 500 off → on: `flush` 15.6 / 25.5 → 0.16 / 0.22
(the OUT batches; the writes are the gateway's 152 ms/s), `interest` + `crowd` 6.8 / 14.7 → 2.6 / 5.6 (per pass:
snapshot 2.6 ms, own slice 1.4, wait 0.4, apply 0.8; each worker's slice 1.5 ms), `inbound` 1.19 → 0.81 (the verdicts;
decode and validate are the gateway's). Town 1,000: `flush` 34.5 → 0.2, `interest` + `crowd` 19.4 → 5.7 (per pass:
snapshot 4.4, own 3.9, wait 1.6, apply 1.6).

- **Gates:** town 500 tick p95 7.5 ms (P1b gate ≤ 15) and the tick thread −78 % / the core process −70 % (P1a gate
  −30 %), RTT p95 9.5 ms (≤ 40); spread 1,000 p95 9.3 ms and town 1,000 p95 15.8 ms (gate: within budget).
- **The work moved, it did not vanish:** the CPU of all processes together is the same in a crowd (24 %) and a few
  points higher spread out (the extra hop costs about what it saves when traffic is low). That is the point: the
  simulation thread keeps ~5–10 % of a core at 500–1,000 players, so P3 starts from a light zone thread.
- The gateway is the heaviest helper (town 1,000: 41 % of a core here, ~1 core on the N100); a second gateway only
  splits it (town 500: 2 × 9.5 %, no tick change): add one when a gateway passes ~60 % of a core (`/netstats`
  `gateways.list[].cpuUserMs/cpuSystemMs`, the netload report's `gateways[].cpuPct`).
- The RTT (bot pings, answered by the core, two pipe hops) fell because the core's event loop is freer (loop delay
  p99 town 500 32 → 23 ms, town 1,000 61 → 30 ms).
- Memory: a gateway process ~105–145 MB RSS; the AoI workers add ~55 MB to the core (idle RSS 660 → 717 MB).
- netload's report adds `server.mainThreadPct`, `server.totalCpuPct`, `gateways[]` (CPU, write/read ms per s, frames,
  loop p99, RSS, slow closes) and `aoiJobs` (passes, fallbacks, snapshot/own/wait/apply ms, worker CPU and slice ms).

**Deviations from §3.3** (deliberate, for P1): hello/auth and the lobby stay in the core (rare and cheap; the
one-socket-per-account map stays where it was, so duplicate logins across gateways need nothing new); the gateway link
is a purpose-built pipe protocol, not yet the generic `bus/` Transport (P2 introduces `PortTransport` for its threads
and can wrap this link as the `IpcTransport`); with one core process the "director routing table" is the hub's
connection map. The AoI pass is not incremental yet (each pass is a full snapshot; at town 1,000 the snapshot is 4.4 ms
of the tick thread's 10 ms).

**Failure handling as built.** Gateway crash: the hub sees the child's `exit`, ends each of its connections as a
dropped socket (`socket error gateway exit`: `dropHoldsBody` → held for `RESUME_GRACE_S`, 15 s), restarts the gateway
with back-off (250 ms doubling to 5 s; reset after a minute up); the clients reconnect (the OS closed their sockets with
the process) and take their bodies back through the resume path — the world never lived in the gateway. Core crash:
the gateways see the IPC `disconnect` and exit. Gateways ignore SIGINT/SIGTERM (a Ctrl+C or a group signal): the core
runs the shutdown — saves, notices and close frames through the gateways, then `SHUTDOWN` (they flush, close every
socket and exit; killed after 3 s). If no gateway starts within 20 s, the core logs it and keeps the sockets itself.
AoI worker crash: its slices are computed on the tick thread until it is back (1 s).

**On the VPS (systemd, Ubuntu, 4 vCores).** Nothing changes in the unit's shape: the gateways are `fork`ed children
of the server process, in its cgroup. Recommended `~/silkroad/silkroad.env` (or `silkroad.local.env`):

```
GATEWAYS=1        # 2 only when one gateway passes ~60 % of a core (crowds of ~800+ on 4 small cores)
AOI_JOBS=2        # the workers only run during interest passes (5/s, a few ms each); 1 is enough under ~500 players
```

That is one core for the tick thread, one for the gateway, and two lightly used worker threads plus SQLite/GC on the
rest. Keep `KillMode=mixed` (deploy/remote/silkroad.service already has it): SIGTERM reaches the server process only,
which saves and then stops its gateways; `TimeoutStopSec=20` covers that (the gateways need < 1 s). Add
`LimitNOFILE=65536` to the `[Service]` section before running more than ~1,000 players: each player is one open socket
in a gateway, and a user unit's default soft limit is 1,024 descriptors. Rollback without a deploy: `GATEWAYS=0
AOI_JOBS=0` and `systemctl --user restart silkroad`. The journal shows `gateways: 1 process(es) own the client sockets`
and `gateway 0: ready (pid …)` at start, and `gateway N: exited …; restarting` on a crash.

**Private build** (the next merge into `C:\dev\jangan-private-wt`). A trial `git merge-file` of world.ts, game.ts,
config.ts and netstats.ts against the private versions merges cleanly; **connection.ts has one conflict**: the private
branch added a two-line comment inside the old `onFrame` (the flood ceiling covers `flyInput`/`swimInput`), which is
now `FrameGate.check` in `gateway/gate.ts` — take master's side (optionally move the comment to `MSG_RATE` in
gate.ts). Everything the private modules use is kept: `Connection.handle` (the `flyInput`/`swimInput` cases and their
`this.budget(msg.t, CLIENT_RATE_LIMITS[msg.t])`, `court.steer` in `moveTo`, `flight.land`/`court.land` in
`leaveWorld`), `Player.send`, `broadcastAbout`, `known`, `positionAt`, `world.players`. With gateways the 20/s
`flyInput`/`swimInput` are decoded and flood-checked in the gateway (they are not in `MESSAGE_RATE_LIMITS`, so they
reach the core as verdicts and keep their answered budgets there); `flyAck`/`fly`/`swim` go out through the OUT
batches like every message. The private branch changes no visibility rule (`canSee`, `inRange`, the crowd): the AoI
kernel needs nothing; a future private visibility rule (e.g. Court-only entities) must be added to the kernel's flags
too, and the lockstep test will catch a mismatch. After the merge run `p0-equivalence.test.ts`, `p1-gateway.test.ts`
and the flight and Court suites, also with `SRO_TEST_GATEWAYS=1 SRO_TEST_AOI_JOBS=2`.

## 5. Open questions and risks

- **Memory per zone worker** (F6): answered by P0 (§4.1): content tables are a few MB and the world's own heap ~50 MB;
  the navmesh's ~100 MB of typed arrays is the one thing to share (SAB). The rest of the RSS is the runtime.
- **One cell, one core:** a single plaza crowd beyond ~1,500 is bounded by one zone thread even with AoI jobs; the
  crowd cap and encode-once are the levers there (and binary encoding R2 in the gateway). P1 measured town 1,000 at
  10 ms of the tick thread per 100 ms (§4.2), 4.4 ms of it the AoI snapshot: an incremental pass is the next lever.
- **Gateway CPU in a crowd** (§4.2): 41 % of a core here at town 1,000, about a whole N100 core; a second gateway
  splits it. Binary encoding (R2) or larger OUT records would cut the per-socket framing.
- **Quests and events spanning cells** (kill counts near a border, siege waves) are covered by "the owner of the
  affected entity decides" plus pinning; each module's border cases need a test in P3.
- **Spread regression (§1.1)**: did not reproduce in P0's back-to-back runs (§4.1: the same build with the P0
  switches off measures 18 / 27 ms, as on 2026-10-10); with P0 on, spread 500 costs a few ms per tick.

## 6. What to start with

P0 is done (§4.1): the per-phase timers measure every later step the same way, and the O(N²) scans are gone. P1 is
done (§4.2): the socket work is in gateway processes and the crowded interest pass on worker threads; the simulation
thread keeps ~5 ms per 100 ms tick at town 500 and ~10 ms at town 1,000. Next is **P2** (DB writer thread + global
services): it is ready to start — Connection already talks to a transport (`ConnSocket`), the gateway link is the
first process boundary (wrap it as the `IpcTransport` when `bus/` and its `PortTransport` arrive with the writer
thread), and nothing in P1 touched persistence, so P2's economy invariants start from today's `inventoryTx`/`pairTx`.

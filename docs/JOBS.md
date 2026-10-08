# Jobs: Trader, Hunter, Thief on Jangan island

**Status (2026-10-08): layers 0-7 built and polished** (see the layer status sections and "Polish status" below). The user: "let's add the job system too, just do what's best". This
spec grows SIEGE.md §8 ("the minimal job system") into the retail three-job war, adapted to the game as it is now: one
town on an island (COAST.md §4.1), a level cap of 25 (CLIMB.md), the siege law already built (Wanted, Bounty Hunters,
the Garrison Stockade, anti-collusion: SIEGE.md §8, layer 6 status). Written at the state of `main` on 2026-10-08
(migrations up to 24). Every choice is a [decision] with its reason; facts are [confirmed] with a source; retail facts
from memory are [likely] or [unknown]; numbers not yet modelled are [projected].

---

## 0. Summary

1. **Three jobs, one per character, one side per account.** Trader and Hunter are one alliance, Thief the other. The
   Hunter job **is** today's Bounty Hunter licence (Captain Yun, one licence, one duty toggle). Join at level **15**.
2. **Job mode = the job suit on.** Putting the suit on is the duty toggle for all three jobs. In job mode, members of
   opposing sides may fight outside safe areas; nobody else is affected (`pvpAllowed` gets three rows).
3. **Trade runs inside the island.** Buy Jangan's seven retail specialties from **Specialty Trader Jodaesan** (already
   standing in the market), load them on a **trade transport** (retail Donkey / Horse / Thoroughbred / Ironclad Trade
   Horse), walk them to one of **four trade posts**: the South Beach, the Tomb Camp, the Ferry Landing, the Sea Cliffs.
   The margin grows with distance and danger; each post sells its own goods back; prices drift with supply.
4. **Thieves** take a licence from **Old Fang the Fence** (the siege's keg seller), kill transports, pick up the
   dropped goods and sell them at the **Bandit Den**: **Specialty Trader Seopok**, the bandits' market retail already
   puts in the Bandit's Mountain Stronghold. Stolen goods pay at most 60 % of what they cost, so robbing your own
   caravan always loses money.
5. **Robbery flows into the law.** A Thief carrying stolen goods holds an open **robbery warrant**: on-duty Hunters get
   pings, and a capture sends the Thief to the Garrison Stockade on a short, separate sentence ladder. Selling at the
   den closes the warrant. Wall-breaking stays the serious crime.
6. **Job EXP is separate from character EXP**; job levels 1-7 unlock bigger loads (trade stars), better transports and
   the three suit tiers. No stat bonuses. Level 7 is a post-cap goal at 25.
7. **Threats on the road**: Thieves, bandit ambushes scaled by trade stars, aggressive monsters, lightning (hurts
   everyone, the transport too), tornadoes (scatter goods). The far posts sit in bands B7 and B8.
8. **Anti-collusion** reuses the siege's: associates and recorded contacts cannot rob each other, the pair rule, daily
   caps, `law_flags` rows for the admin. On top: one side per account, and the den's 60 % ceiling.
9. **Looks**: retail job suits (`hunter_02.bsr`, `thief_02.bsr`, `trader_02.bsr` for man and woman) on the
   adventurer bodies; on licensed-pack bodies, the worn outfit plus a job palette and an emblem through the MatID dye
   (CHARACTERS.md §16.9).
10. **Effort ≈ 28.5 agent-days** over 8 layers. A Trader-only loop (buy, walk, sell, get robbed by monsters) is
    playable after layers 0-3 and 5 (≈ 18.5).

---

## 1. Today [confirmed unless tagged]

| Fact | Where |
|---|---|
| `char_jobs (character_id, job, rank, points, licensed_at, revoked_until, on_duty)`, PK (character_id, job); only `job = 'hunter'` is written today | migration 19, `apps/server/src/db.ts` |
| `warrants.reason` is `'wall'`; SIEGE.md §8.7 reserved `'robbery'`; `law_records` per account; `jail_terms`; `law_contacts`, `law_flags` (migration 20) | `db.ts`, `siege/law-store.ts` |
| `pvpAllowed(a, b, associates)` is one function over `PvpSide`; `pvpDamage` = `hunter.pvpMul` on every player-on-player hit | `packages/shared/src/siege-hunter.ts`, `gameplay.ts dealHits` |
| Bounty Hunters: Captain Yun (−145, −207), `hunter` service, licence level 15 / 10,000 gold / 30 days clean, duty toggle, ranks 0-5 by captures (1, 3, 10, 25, 60), the Hunter's Net, pings, captures, bounty split | `siege/hunters.ts`, SIEGE.md layer 6 status |
| The player-facing role is being renamed "Hunter" → "Bounty Hunter" by another lane right now; rank 2 is also called "Bounty Hunter" (`hunter.rank.2`) | `apps/game/src/i18n/en-siege-hunter.ts`, `apps/admin/src/pages/siege-law.ts` |
| Old Fang the Fence (`NPC_SIEGE_OLD_FANG`) at (−520, −232), outside the safe area, sells the Thunder Keg | `packages/shared/src/siege-law.ts FENCE_SPOT` |
| **Specialty Trader Jodaesan** (`NPC_CH_SPECIAL`) at (176, −48) in the town market; **Specialty Trader Seopok** (`NPC_CH_SPECIAL2`, a thief-den model `thiefden_thief_e`) at (−1495, 808), y 138, in the Bandit's Mountain Stronghold, greeting "a trade market run by Bandits" | `work/out/data/npcs.json` |
| Retail trade goods of China: `ITEM_ETC_TRADE_CH_01..07` White Silk, Red Silk, Blue Celadon Vase, Wolju Celadon Vase, Tiger Eye Stone, Poplar Tree, High Class Tiger Leather; of Western China `WC_01..07` Leather, Footstall, Saddle, Horseshoe, Brown Pearl, Silver Bar, Gold Bar; ground model `item\etc\drop_trade.bsr`, icons `item\etc\trade_ch_0N.ddj` | `itemdata_*.txt`, `textdata_object.txt` |
| Retail job suits: `ITEM_CH_<M\|W>_TRADE_<TRADER\|HUNTER\|THIEF>_02..05` (+ `_04_01`, `_05_01`), models `item\china\<man\|woman>_item\<job>_02.bsr` | `itemdata_*.txt` |
| Retail transports: `COS_T_DONKEY` "Donkey" (retail lv 20), `COS_T_HORSE1/2/3` "Horse", "Thoroughbred", "White Horse", `COS_T_DHORSE1/2/3` "Ironclad / Silverclad / Goldclad Trade Horse", camels, cows, … Not exported: `cos.json` holds only the Red Horse | `characterdata_*.txt`, `work/out/data/cos.json` |
| Retail job UI art: `interface/character/chr_job_window.ddj`, `equipment/equip_slot_job_button*.ddj`, `ifcommon/com_job_gauge_{hunter,merchant,thief}.ddj`; `ITEM_ETC_SCROLL_RETURN_THIEFDEN_01` "Bandit Den Return Scroll" | `work/extracted/Media` |
| Horses: summon by item, ride, park, HP, hits on the rider land on the horse, death drops nothing, `char_mount` persistence | `apps/server/src/mounts.ts` |
| Siege looters (Bandits spawned at a breach) | `siege/looters.ts` |
| The island: only Jangan; places `ferry-heights` (−1900, 450), `sea-cliffs` (−2050, 1000), `western-strait` (−2260, 320, the old ferry landing, piers kept), `jangan-south-beach` (480, 1276), the tomb plaza with the Steward at (864, −1040), `tiger-camp-*` | `content/places.json`, COAST.md §4.1, TOMB_DUNGEON.md |
| No boats, no sailing: the sea past the shelf is out of play | COAST.md §4.1 |
| Bands: B4 Tomb Approach 12-15, B5 Tiger Mountains 14-19, B7 Ferry Heights 19-23, B8 Sea Cliffs 22-25; monster gold × band factor | CLIMB.md §2.1, §4.5 |
| Associates (party, guild, same account, same IP) | `pilot/hunt.ts isAssociate` |
| An achievements / title module is designed (`char_achievements`, `EntityState.title`) | CLIMB.md §7.3 |

### 1.1 Retail job facts (from memory)

| Fact | Tag |
|---|---|
| Three jobs: Trader and Hunter allied, Thief opposed | [likely] |
| Job mode by wearing the job suit; in job mode, opposed jobs may fight in the field; towns are safe | [likely] |
| Traders buy specialties in town in job mode, load a summoned transport, sell at another town's specialty trader; profit by distance and price | [likely] |
| Trade scale shown as stars by the value of the load; more stars = more NPC thieves on the road and more job EXP | [likely] |
| Job levels 1-7 in the original game (later raised) | [likely] |
| Hunters earn by escorting Traders (party) and killing Thieves; Thieves by selling stolen goods at the Thieves' Den (near Donwhang) | [likely] |
| A transport killed drops its goods; Thieves pick them up | [likely] |
| Dying in job mode drops carried goods | [likely] |
| Changing job costs the job level and a waiting period | [likely; exact period unknown] |
| Required character level 20 to join | [unknown] |
| Whether a transport could be ridden | [unknown] |
| Whether Hunters picking up dropped goods returned them to the Trader | [unknown] |

---

## 2. The jobs and the licences

### 2.1 Who sells which licence [decision]

| Job | NPC | Where | Price | Reason |
|---|---|---|---|---|
| **Trader** | Specialty Trader **Jodaesan** (`NPC_CH_SPECIAL`, new `trader` service) | town market (176, −48) | 10,000 gold | he already sells the goods; no new NPC |
| **Hunter** ("Bounty Hunter", §2.3) | **Captain Yun** (existing `hunter` service) | west gate (−145, −207) | 10,000 gold (unchanged) | the siege licence becomes the job licence: one licence, one duty toggle |
| **Thief** | **Old Fang the Fence** (existing NPC, new `thief` service) | his camp (−520, −232), outside the safe area | 10,000 gold | the fence already sells the outlaws' kegs; a thief must walk out of town to join |

- **Requirements** (all three): character level **15**, not Wanted, not jailed [decision: 15 is the Bounty Hunter's
  level already; the near posts suit 15-18 and the far ones are the level-19-25 challenge]. The Hunter keeps its "30
  days clean" rule; a Thief needs no clean record.
- **One job per character** [decision: retail; enforced in code, `char_jobs` keeps one row per character].
- **One side per account** [decision: the strongest single guard against robbing your own caravan with an alt]:
  `account_jobs.side` = `law` (Trader, Hunter) or `outlaw` (Thief). Every character of the account must join on that
  side. Changing side: allowed after **7 days** since the last change; every job on the old side is left.
- **Leaving a job** (at its NPC): job level and job EXP are lost, the suit is taken back, a **3-day** wait before
  joining another job [decision: retail-like cost without a long lockout]. A Hunter licence revoked by a GM or by
  breaking a wall (SIEGE.md §8.2) stays revoked as today.

### 2.2 Job mode (the duty toggle) [decision]

- **Job mode = the job suit is on.** The suit is a bound item in the job slot (the retail `equip_slot_job_button`
  look); putting it on or taking it off is `jobMode {on}` (a HUD button, the NPC, or equipping the suit item).
- The existing `hunterDuty` request becomes an alias of `jobMode` for Hunters, so today's HUD keeps working.
- **On**: in a safe area (Trader, Hunter) or at Old Fang's camp or the Bandit Den (Thief), out of combat. Reason: the
  outlaws dress at their own places; a Thief in suit may still walk into town (no PvP there).
- **Off**: refused for `mode.offLockMin` (2, = `hunter.offDutyLockMin`) after the last PvP hit, and refused while a
  transport is loaded or stolen goods are carried [decision: no shedding the target mid-run].
- In job mode: a job label line under the name (job colour, emblem, job level name), the PvP rules of §4, return
  scrolls and teleports refused while loaded or carrying stolen goods; everything else (hunting, skills, parties) as
  normal.

### 2.3 Today's Bounty Hunter → the Hunter job [decision]

- **Player-facing name: "Bounty Hunter"**, the name the user just chose, everywhere the job is named (Yun's window,
  the job window, the label). The job triad reads **Trader · Bounty Hunter · Thief**. Internal id stays `hunter`.
  Reason: it tells players this job hunts players for bounties, not monsters, and it keeps the rename. Switching to
  retail's plain "Hunter" is one string (`job.hunter.name`).
- **Rank 2's name clashes** (`hunter.rank.2` "Bounty Hunter"): the job-level names (§3.2) replace the ranks and level 3
  is called **"Bloodhound"**. Layer 1 does this after the rename lane lands; this spec does not touch those files now.
- **Migration**: every `char_jobs` row `hunter` keeps its licence and duty; its rank r (0-5) becomes job level r + 1
  with the job EXP of that level's threshold; captures keep counting (§3.3). Existing `account_jobs.side` = `law`.
- Bounties, the Net, pings, captures, the jail and every SIEGE.md §8.6 rule are unchanged; the Hunter job adds Thieves
  as targets (§4) and escorts (§3.3).

---

## 3. Job levels, EXP and rewards

### 3.1 Job EXP [decision]

**Separate from character EXP**: job actions give job EXP only; monsters killed on a run give their normal character
EXP. Reason: the Climb's curve (CLIMB.md §3.2a) stays the one path to 25, and trading cannot become a power-levelling
shortcut.

| Job | Source | Job EXP |
|---|---|---|
| Trader | a sale with profit > 0 | profit ÷ 10, × 1.0 / 1.1 / 1.2 / 1.35 / 1.5 at 1-5 stars |
| Hunter | escort: in the Trader's party, in job mode, within 50 m at the sale, not the same account or IP | 40 % of the Trader's job EXP of that sale (at most 2 Hunters) |
| Hunter | a Thief in job mode killed or captured (pair rule §7) | 300 × the Thief's job level; a robbery capture × 2 |
| Hunter | a wall-breaker captured (today's capture) | 2,000 |
| Thief | stolen goods sold at the den | den payout ÷ 8 |
| Thief | a transport killed (the Thief dealt ≥ 25 % of its HP) | 200 × stars |

### 3.2 Levels 1-7 [decision; thresholds projected]

| Job level | Job EXP | Suit tier | Max stars | Trader transport | Hunter | Thief | Names (Trader / Hunter / Thief) |
|---|---|---|---|---|---|---|---|
| 1 | 0 | I | 2 | Donkey | sense 120 m | – | Peddler / Recruit / Pickpocket |
| 2 | 2,000 | I | 2 | Donkey | | | Hawker / Tracker / Cutpurse |
| 3 | 6,000 | II | 3 | Horse | net cooldown 50 s | Bandit Den Return Scroll | Merchant / Bloodhound / Footpad |
| 4 | 15,000 | II | 3 | Horse | | | Caravaneer / Manhunter / Highwayman |
| 5 | 35,000 | II | 4 | Thoroughbred | sense 160 m | transport ping 160 m | Trade Master / Hunter Sergeant / Brigand |
| 6 | 70,000 | III | 5 | Thoroughbred | | | Merchant Prince / Hunter Captain / Bandit Chief |
| 7 | 130,000 | III | 5 | Ironclad Trade Horse | title "Warden of the Roads" | title "King of the Road" | Silk Lord / Warden of the Roads / King of the Road |

- **No stat bonuses** [decision: as Hunter ranks today; jobs must not split PvE power].
- Pace [projected]: level 7 Trader ≈ 1.3 M gold of profit ≈ 50-70 runs; reachable in the weeks after the cap, so it
  joins CLIMB.md §7.1's goals at 25. Titles through the achievements module (CLIMB.md §7.3): "Silk Lord", "Warden of
  the Roads", "King of the Road", plus "Caravan of a Hundred" (100 sales) and "Never Robbed" (25 sales in a row).

### 3.3 Suits [decision]

| Tier | Job levels | Retail model (adventurer bodies) | Licensed-pack bodies |
|---|---|---|---|
| I | 1-2 | `<job>_02` (`ITEM_CH_<M\|W>_TRADE_<JOB>_02`) | the worn outfit, job palette on MAIN / SECOND, emblem on the chest |
| II | 3-5 | `<job>_03` | + trim in the job colour, emblem on the back |
| III | 6-7 | `<job>_04` (and `_04_01` where it exists) | + D4-style twill in the job colour, gold (Trader), silver (Hunter) or soot-black (Thief) trim |

- Job colours: **Trader gold-brown, Hunter blue (today's badge), Thief black with red trim**. A job palette is one more
  `PALETTES` row keyed `job:<id>:<tier>` that overrides the gear's palette while the suit is on; the emblem is a small
  decal in the MatID dye map's trim region (CHARACTERS.md §16.9) [decision: reuse the outfit-from-gear path; no new
  meshes on the licensed bodies].
- A body without the licensed pack shows the retail suit models (they exist in the data, §1); a server whose export
  lacks them falls back to the worn gear with the label colour only.
- The suit gives no stats (retail suits carried small stats [unknown]; here none, to keep §3.2's rule).

---

## 4. The PvP rule, extended [decision]

`pvpAllowed(a, b, associates)` keeps its signature; `PvpSide` gains `job: 'trader' | 'hunter' | 'thief' | null`,
`jobMode: boolean` and `inJobSafe: boolean` (a safe area, the Stockade, a post ring or the den ring, §5.2).

| Attacker | Target | Allowed | Where |
|---|---|---|---|
| on-duty Hunter | Wanted (wall or robbery), not an associate | yes (today) | anywhere but the Stockade |
| Wanted | on-duty Hunter | yes (today) | same |
| Trader or Hunter in job mode | Thief in job mode | **yes** | outside `inJobSafe` |
| Thief in job mode | Trader or Hunter in job mode | **yes** | outside `inJobSafe` |
| Thief in job mode | a loaded **transport** | **yes** | outside `inJobSafe` |
| Trader ↔ Hunter, Thief ↔ Thief, anyone ↔ out of job mode | | no | – |
| any | an associate or a recorded contact (§7) | no | – |

- `pvpDamage` (×0.5) applies to every row. A death in job mode is a PvP death: **no character EXP loss** (CLIMB.md
  §6.1: only monsters take EXP). It drops carried goods (§6.3).
- Party heals and buffs as today. Area skills hit only bodies `pvpAllowed` allows.
- **Towns stay safe for the job war** [decision: Traders shop and Hunters gather there; the Wanted row keeps its
  "town is no sanctuary" exception].

---

## 5. Trade

### 5.1 The route map [decision; distances confirmed from the place coordinates, straight line from Jodaesan]

```
                          N (−z)
        Ferry Landing ●            Jangan Bay
     (−2260, 320) B7 ★★★★              ·        ● Tomb Camp (840, −990) B4
          2.46 km                      ·          1.20 km  ★★
                \        Bandit Den ◆                  /
                 \    Seopok (−1495, 808)    JANGAN ■ Jodaesan (176, −48)
   Sea Cliffs ●   \      1.88 km, B5           /
 (−2050, 1000)     \_____________ Tiger Mts ___/
   B8 ★★★★★ 2.46 km                                \
                                                    ● South Beach (480, 1276)
                          S (+z)                        1.36 km  ★
```

| Post | NPC (retail model reused) | Spot | From Jodaesan | Road danger | Margin on Jangan goods | Sells |
|---|---|---|---|---|---|---|
| **South Beach** | Pearl Diver Haeun (`chinashop_spacialmerchant`, recoloured) | by `jangan-south-beach`, above the tide line | 1.36 km | 1 (B1-B2, the S1 beach) | **+8 %** | Brown Pearl |
| **Tomb Camp** | Quartermaster Gong (a soldier model) | the tomb plaza's south edge (≈ 840, −990), > 50 m from the door and outside the Stone Ghost roams | 1.20 km | 2 (B4 aggressive packs) | **+11 %** | – (buys only) |
| **Ferry Landing** | Ferry Master Wol (the old ferry NPC model if exported, else a merchant) | the piers by `western-strait` | 2.46 km | 4 (B5, B7) | **+21 %** | Leather, Footstall, Saddle, Horseshoe |
| **Sea Cliffs** | Salvager Mok (a fisher model) | a ledge by `sea-cliffs`, not on MB8's crest | 2.46 km | 5 (B5, B8) | **+24 %** | Silver Bar, Gold Bar |
| *Bandit Den* | Specialty Trader Seopok (exists) | Bandit's Mountain Stronghold | 1.88 km | B5 | – (Thieves only, §6.4) | Bandit Den Return Scroll |

- Spots are snapped by the places tool (open ground in the town's walkable component) [projected]; each gets a place
  row `trade-<post>` for GM teleports.
- **Why these four**: the user's list; they spread over every direction and every danger step, so a Trader picks
  between short-safe-cheap and long-deadly-rich. The Ferry Landing and the Sea Cliffs are equally far but the Cliffs
  run through B8 (22-25), so their margin is higher.
- **No sea route in v1** [decision]: no boat system exists and the sea is out of play (COAST.md §4.1). A later
  "ferry crossing" (an NPC warp from the Jangan Bay shore to the Ferry Landing, 90 s, a toll of 15 % of the load,
  no robbery, cancelled in storms) is §14's option, not built.
- **Post to post** trades are allowed (pearls from the beach sold at the Cliffs): the margin is
  `0.02 + 0.02 × km + 0.035 × danger` between any two trade points [projected; it reproduces the table within 1 %].
  Goods are always sellable at Jodaesan; selling a good where it was bought pays its buy price × 0.9.

### 5.2 Goods and prices [decision; prices projected]

| Good | Bought at | Base price per crate |
|---|---|---|
| White Silk, Red Silk | Jangan | 800, 1,000 |
| Blue Celadon Vase, Wolju Celadon Vase | Jangan | 1,500, 1,900 |
| Tiger Eye Stone | Jangan | 2,400 |
| Poplar Tree | Jangan | 600 |
| High Class Tiger Leather | Jangan | 3,000 |
| Brown Pearl | South Beach | 2,000 |
| Leather, Footstall, Saddle, Horseshoe | Ferry Landing | 700, 900, 1,400, 1,100 |
| Silver Bar, Gold Bar | Sea Cliffs | 2,600, 4,000 |

- Goods are **crates** (stack 10) that live only in the transport's hold (not the bag) [decision: retail; it makes the
  transport the target]. Robbed goods become **stolen crates** in the Thief's bag (bound, §6.4).
- **Sell price** = base × (1 + margin(origin, post)) × demand(post, good) × (1 − `trade.taxPct` 3 %).
- **Price drift by supply**: each crate sold at a post lowers that post's `demand` for the good by `drift.sellImpact`
  0.2 % (floor 0.70); each crate bought at its source raises the buy price by `drift.buyImpact` 0.1 % (cap 1.30);
  both recover toward 1.00 at `drift.recoverPerHour` 3 %. Reason: a popular route pays less until others move on;
  the windows show the current figure and an arrow.
- **Per-account buy cap**: `trade.buyCapPerHour` 300 crates [decision: stops one account pumping or dumping a price].
- **Daily market news** at Jodaesan: one good at one post gets demand 1.20 for the day (from the server RNG at 00:00).

### 5.3 Trade scale (stars) [decision; thresholds projected]

| Stars | Load value (bought price) | Bandit ambushes on the way (§6.2) | Job EXP × |
|---|---|---|---|
| ★ | < 25,000 | none | 1.0 |
| ★★ | 25,000 | 0-1 | 1.1 |
| ★★★ | 60,000 | 1 | 1.2 |
| ★★★★ | 120,000 | 1-2 | 1.35 |
| ★★★★★ | 200,000 | 2-3 | 1.5 |

The job level caps the stars (§3.2): a load above the cap cannot be bought. The stars show over the transport.

### 5.4 Transports [decision; HP re-levelled, projected]

| Transport | Retail code | Job level | Hold (crates) | HP | Walk speed | Summon item (single use) |
|---|---|---|---|---|---|---|
| Donkey | `COS_T_DONKEY` | 1 | 30 | 2,500 | 4.0 m/s | 2,000 gold |
| Horse | `COS_T_HORSE1` | 3 | 60 | 3,800 | 4.5 m/s | 5,000 |
| Thoroughbred | `COS_T_HORSE2` | 5 | 90 | 5,000 | 4.8 m/s | 9,000 |
| Ironclad Trade Horse | `COS_T_DHORSE1` | 7 | 120 | 7,000 | 4.5 m/s | 14,000 |

- Retail levels (20-75) are above the cap; HP is re-derived so 2-3 level-20 Thieves kill a Horse in ≈ 30-40 s
  [projected: CLIMB's ≈ 50 DPS × `pvpMul` 0.5 per player].
- **Built on `mounts.ts`**: a transport is a `Cos` with a `hold`; summoned at Jodaesan or a post (a 20 m ring), one
  per character, not with a horse. It **follows** its Trader (leash 25 m; farther than 60 m it stops and waits).
  The Trader may **ride** it at its walk speed [decision: the retail answer is unknown; riding at a walk keeps the
  pace and lets the Trader not fight].
- **Attacked by**: Thieves in job mode, bandit ambushers, aggressive monsters (a transport counts as a player for mob
  targeting while loaded), lightning, tornadoes. Never by Traders, Hunters or anyone out of job mode.
- Healed by Recovery Kits (as horses). No regeneration.
- **Unloaded** at a sale: it stays summoned for the way back (buy return goods) or is dismissed (the summon item is
  spent either way: a gold sink).

### 5.5 A run, end to end

1. Suit on in town; summon at Jodaesan; buy crates (stars shown live); leave.
2. On the road: ambushes by stars, monsters, storms, Thieves (who get pings, §6.1).
3. At the post (within 6 m of the NPC): sell; gold, job EXP, escort shares, the post's goods for the way back.
4. Return scrolls are refused while loaded; after selling, a scroll home is allowed (the transport is dismissed).

---

## 6. Threats, robbery and the den

### 6.1 Who sees whom [decision]

- Thieves in job mode get a **caravan ping** every 60 s for each loaded transport of ★★★ or more within 400 m: a 120 m
  circle around a point within 60 m of it (the Hunter ping, mirrored). Level 5 Thieves: the circle shrinks to 80 m.
- On-duty Hunters keep their Wanted pings and add robbery warrants (§6.4).
- A Trader sees a red ring on any Thief in job mode within 60 m.

### 6.2 Bandit ambushes [decision]

- Per §5.3, at random points between 30 % and 80 % of the straight distance to the declared destination (the
  destination is chosen at purchase: it fixes the stars' meaning and the ambush points), a group of Bandits at the
  Trader's band (the B5 Bandit / Bandit Archer rows, or B7 / B8 rows past 1.6 km) spawns 30 m off the road and
  targets the transport. Built on `siege/looters.ts` [decision: reuse].
- They drop normal loot; they never pick up goods. Killed goods from an ambush drop as bags (§6.3) that Thieves may
  still take.

### 6.3 A transport or carrier dies [decision]

- **Transport at 0 HP**: `thief.dropPct` 60 % of its crates (rounded per good) drop as **goods bags** (retail
  `drop_trade.bsr`) around it; the rest are destroyed. The Trader keeps the gold paid.
- **Trader dies with a loaded transport**: the transport stays 30 s (still a target), then drops as above. Reason:
  killing the Trader is not a shortcut around the transport's HP, and a Trader's friends can save it.
- **Thief dies in job mode carrying stolen crates**: they drop as bags.
- **Bags** last 5 min, seen by job-mode players only. Picking up: a **Thief** → stolen crates in the bag; the **owning
  Trader or his party** → back into the transport (or the bag if it is gone, sellable by him only); a **Hunter** not
  in that party → turned in to Captain Yun for a recovery reward (§6.4). Associates of the owner cannot pick his bags as
  Thieves (§7).

### 6.4 Robbery and the law [decision]

- A Thief who picks up stolen crates gets an open **robbery warrant** (`warrants.reason = 'robbery'`), visible to
  job-mode players as **ROBBER** on the label; on-duty Hunters get its pings (SIEGE.md §8.1). No server-wide notice.
- The warrant **closes** when the crates are sold at the den, dropped by a death, or after 30 min online (the crates
  stay sellable).
- **Captured** by Hunters (SIEGE.md §8.4 unchanged): subdued, the crates confiscated, the Thief to the **Garrison
  Stockade** on the **robbery ladder** 15 / 30 / 60 / 120 min (per account, `law_records.robberies`, one level forgiven
  per 7 clean days). Separate from the wall ladder [decision: robbery is the job's game, wall-breaking the crime].
  The capturing Hunters split a **recovery reward** of `law.recoveryPct` 25 % of the den value, counted in
  `hunter.dailyBountyCap`.
- **The Bandit Den** = Specialty Trader Seopok. He pays `thief.denPct` **60 %** of the crates' base price (no margin,
  no drift), and sells the Bandit Den Return Scroll (job level 3). A **12 m ring** around him is safe for everyone
  [decision: otherwise Hunters camp the only sell point and the job dies]. The return scroll is refused while
  carrying stolen crates.
- **Economics** [projected]: a 100,000 load robbed → 60 % drops → den pays 60 % of base ≈ 36,000; the Trader lost
  100,000. Robbing your own caravan costs ≥ 64 % of the load: never a profit.

### 6.5 Storms and the world [decision]

- **Lightning** hurts everyone (the user's rule), the transport included (as a player hit).
- **Tornado**: a transport inside the lift radius drops `storm.tornadoScatterPct` 20 % of its crates as bags along the
  path.
- **Snow** (WINTER, Dec 1-Jan 15): transports −10 % speed outside town.
- Monster roles (CLIMB.md §2.3) apply to transports as to players; a coward's call for help can pull a pack onto it.

---

## 7. Anti-collusion and abuse [decision; the siege's rules reused]

| Abuse | Guard |
|---|---|
| an alt robs your own caravan | one side per account (§2.1); associates (party, guild, same account, same IP) and recorded contacts (`law_contacts` + `social_log`, `law.contactDays` 7) cannot attack the transport or pick its bags as Thieves; the den's 60 % ceiling makes it a loss anyway |
| friends take turns robbing each other | **pair rule**: the same Thief account robbing (a bag picked) the same Trader account within 24 h: the 2nd pays 50 % at the den, the 3rd+ pays nothing and no job EXP (`law.repeatPct`, `law.repeatMax`); a `law_flags` row `robbery_pair` |
| a Hunter alt farms captures of a Thief alt | same side per account makes it two accounts; SIEGE.md §8.6 rules (associates, contacts, pair, repeat, daily cap) apply to robbery captures unchanged |
| escort farming | escort shares need a real sale (profit > 0), a different account and IP, at most 2 escorts; the escort share is job EXP only (no server gold) |
| price pumping with alts | per-account buy cap; drift floors and caps; sells by one account move demand at most 30 % per day |
| logging out with a hot load | the transport lingers 60 s in the world (targetable), then is saved with its goods and restored at that spot at the next login; combat logout within 10 s of a hit lingers the character too (CLIMB.md §6.1) |
| hiding in a safe ring | the rings are 12 m; the road is long; the transport cannot be summoned loaded |
| dumping goods in storage | crates live only in the hold; stolen crates are bound and cannot be traded, stalled, stored or dropped |
| leaving the job to dodge a warrant | refused while a warrant is open or crates are carried |
| GM misuse | every `job`, `trade`, `transport`, `caravan` command and admin write in `gm_audit` |

Every withheld reward is a `law_flags` row (rules `robbery_pair`, `robbery_contact`, `escort_same_ip`), listed in the
admin Law tab's "Suspected collusion".

---

## 8. Events (optional) [decision]

- **The Silk Caravan** (weekly, Saturday 20:00, **disabled by default**): for 60 min one far post pays demand 1.40,
  ambushes are ×1.5, Hunters' escort shares ×1.5, Thieves' den pays ×1.2. A NoticeBanner at the start. Never during a
  siege or a Night of the Tiger.
- **Daily market news** (§5.2) is always on.

---

## 9. Data and server

### 9.1 Content and settings [decision, as SIEGE.md §11.1]

- `content/jobs/jobs.json`: jobs, levels, names, suits, posts (spot, NPC, sells), goods (base prices), margins,
  transports, stars, ambush rosters, the event; checked at start by `checkJobsContent` in
  `packages/shared/src/jobs.ts`.
- A sparse DB patch `job_settings` for live numbers, validated by `JOBS_BOUNDS`.

| Group | Fields (defaults) |
|---|---|
| jobs | `minLevel` 15, `licenceGold` 10,000, `leaveWaitDays` 3, `sideChangeDays` 7, `levels` [0, 2k, 6k, 15k, 35k, 70k, 130k] |
| mode | `offLockMin` 2, `safeRingM` 12 |
| trade | `taxPct` 3, `buyCapPerHour` 300, `starThresholds` [25k, 60k, 120k, 200k], `maxStars` [2, 2, 3, 3, 4, 5, 5], `margin` {a 0.02, km 0.02, danger 0.035}, `newsDemand` 1.20 |
| drift | `sellImpact` 0.002, `buyImpact` 0.001, `floor` 0.70, `cap` 1.30, `recoverPerHour` 0.03, `accountDayMax` 0.30 |
| transport | per tier `hold`, `hp`, `speed`, `price`, `leashM` 25, `waitM` 60, `lingerS` 60 |
| thief | `dropPct` 60, `denPct` 60, `bagLifeMin` 5, `pingSec` 60, `pingR` 120, `pingMinStars` 3 |
| robbery | `warrantOnlineMin` 30, `sentencesMin` [15, 30, 60, 120], `forgiveDays` 7, `recoveryPct` 25, `pairWindowH` 24 |
| exp | trader `profitDiv` 10, hunter `escortPct` 40 / `thiefKill` 300 / `wallCapture` 2,000, thief `denDiv` 8 / `transportKill` 200 |
| ambush | per star [0, 0.5, 1, 1.5, 2.5] expected groups, `groupSize` [3, 5], rosters per band |
| storm | `tornadoScatterPct` 20, `snowSpeedPct` −10 |
| event | `enabled` false, `slots` [{6, '20:00'}], `durationMin` 60, multipliers |

### 9.2 Modules [decision]

- `apps/server/src/jobs/jobs.ts` (GameplayModule `jobs`, after `hunters`): licences, sides, job mode, job EXP and
  levels, suits, `PvpSide` fields. `hunters.ts` keeps bounties, nets, pings and captures and asks `jobs` for
  "licensed" and "on duty".
- `jobs/trade.ts` (`trade`): market state, buy, sell, drift, news, stars, escorts.
- `jobs/transport.ts`: a `Mounts` extension (a transport kind of `Cos` with a hold, follow, linger, persistence).
- `jobs/robbery.ts` (`robbery`): bags, stolen crates, the den, robbery warrants through `siege/law.ts`, recovery rewards,
  the pair rule; `jobs/ambush.ts` on `siege/looters.ts`.
- Seams: `pvpAllowed` rows (shared), `law.ts` issues and closes `robbery` warrants, `jail.ts` reads the ladder by
  reason, the lightning and tornado services' `onStrike` / `onTornado` hit transports, mob targeting sees loaded
  transports, `item-use.ts` refuses return scrolls while loaded.

### 9.3 Migration (the next free number, 25 at writing; renumber at merge) [decision]

- `ALTER TABLE char_jobs ADD job_exp INTEGER NOT NULL DEFAULT 0`; Hunter rows converted (§2.3).
- `account_jobs (account_id PK, side, side_changed_at, left_at)`.
- `market (post, good, demand, buy_mul, updated_at, PK (post, good))`; `market_account_day (account_id, day, moved)`.
- `transports (character_id PK, code, hp, hold TEXT, dest, stars, x, z, saved_at)`.
- `trade_log (id, at, character_id, account_id, kind buy|sell|robbed|recovered|den, post, good, crates, gold, stars)`.
- `ALTER TABLE law_records ADD robberies INTEGER NOT NULL DEFAULT 0, ADD last_robbery_at INTEGER`.

### 9.4 Protocol (v1, additive)

- Requests: `jobJoin {job}`, `jobLeave`, `jobMode {on}` (`hunterDuty` aliases it), `tradeSummon {tier}`,
  `tradeBuy {good, crates, dest}`, `tradeSell {good?, crates?}`, `transportRide`, `transportDismiss`, `bagPick {id}`,
  `denSell`, `yunTurnIn`.
- Server: `jobState {job, level, exp, mode, side}`, `market {post, rows}`, `transportState {id, hold, stars, dest}`,
  `caravanPing`, `bag {id, x, z, good}`; `entityUpdate.job` (job, tier, mode) and `.stars`; actionResult codes
  `not_job_mode`, `wrong_side`, `stars_cap`, `hold_full`, `loaded`, `buy_cap`.

### 9.5 Admin and GM [decision]

- Routes `registerAdminRouteGroup({prefix: 'jobs'})`, admin role, `gm_audit` per write: GET `jobs` (members by job and
  level, live transports, market, flags), PUT `jobs/settings` (+ reset), POST `jobs/member` `{character, job?, level?,
  exp?, leave?}`, POST `jobs/market` `{post, good, demand}` / `{reset: true}`, POST `jobs/event/start|stop`.
- Panel page **"Jobs & Trade"**: members table, a map of the island with posts and live transports (stars, HP), market
  table with drift arrows and a 7-day price chart, run log, settings groups, the event.
- GM commands: `job <name> [join <job>|leave|level <n>|exp <n>|mode on|off|side law|outlaw]`, `trade price <post>
  <good> <demand>`, `trade reset`, `trade news <post> <good>`, `transport <name> [spawn <tier>|load <stars>|kill|heal]`,
  `ambush <name> [n]`, `caravan start|stop|status`, `bag clear`.

---

## 10. Client [decision]

- **Job window** (the retail `chr_job_window` and `com_job_gauge_*` art): job, level name, job EXP gauge, suit tier,
  stars cap; the job slot in the equipment window.
- **NPC windows**: Jodaesan (licence, market, summon), each post (sell, buy, market), Yun (now "Bounty Hunter", job
  levels instead of ranks), Old Fang (Thief licence), Seopok (den sale, scroll).
- **Transport HUD**: HP, hold, stars, destination, distance; stars over the transport in the world.
- **Labels**: job colour line with the level name; ROBBER; red ring on hostile job members within 60 m.
- **World map and minimap**: a "Trade routes" layer: the four posts, the den (Thieves only), danger tint per band,
  caravan pings for Thieves, robbery pings for Hunters.
- **Looks**: suits (§3.3), transports (export the four `COS_T_*` models and their walk/run/die clips; the hold is
  shown by the retail model as is), goods bags (`drop_trade.bsr`), post NPCs from retail models.
- **i18n**: `apps/game/src/i18n/en-jobs.ts` (new file; the siege strings are another lane's).

---

## 11. Tests

- **Unit**: `pvpAllowed` table exhaustively with the job rows; margins, drift (impact, floor, cap, recovery), stars,
  stars cap by level; job EXP per source; level thresholds; drop and den math (self-robbery always a loss); pair rule;
  one side per account; Hunter migration (rank → level).
- **Integration** (bot clients): a full run to each post; a Thief kills a transport, picks bags, gets a robbery
  warrant, a Hunter captures it → Stockade 15 min; a Thief sells at the den and the warrant closes; the Trader's party
  picks back its bags; logout linger and restore; lightning and a tornado on a transport; an ambush at ★★★.
- **Abuse** (`abuse-jobs.test.ts`): same account Thief vs Trader (refused at join), same IP robbery (no damage),
  contact robbery (no pickup), pair rule ×3, buy cap, return scroll while loaded, job mode off while loaded, leaving
  the job with a warrant, crates into storage or a stall.
- **Load**: 30 Traders with transports and 20 Thieves on the roads with ambushes: tick p99 < 50 ms (the siege gate).

---

## 12. Build plan (each layer playable or testable alone)

| Layer | Delivers | Gate | Size (agent-days) |
|---|---|---|---|
| **0. Data and export** | converter rows for `COS_T_DONKEY/HORSE1/HORSE2/DHORSE1` (cos.json, models, clips), trade goods CH/WC (items, icons, `drop_trade` model), job suit items and models, job UI art; `content/jobs/jobs.json`; `packages/shared/src/jobs.ts` (types, checker, bounds, pure rules: margins, drift, stars, EXP, `pvpAllowed` rows) with unit tests | export green; shared tests green | **2.5** |
| **1. Jobs core (server)** | `jobs.ts` module, migration, licences at Jodaesan / Yun / Fang, sides, leave, job mode (+ `hunterDuty` alias), job EXP and levels, Hunter migration, `PvpSide` job rows live, GM `job`, settings patch + admin GET/PUT | a Thief and a Hunter fight outside town; a Trader and a Hunter cannot | **4** |
| **2. Market (server)** | `trade.ts`: four post NPCs and places, buy / sell / drift / news / stars / tax / caps, escorts, `trade_log`, GM `trade`, admin market routes | a scripted bot buys silk, teleports to the Ferry Landing, sells at +21 % | **3.5** |
| **3. Transports (server)** | `transport.ts` on `mounts.ts`: summon items, hold, follow / ride / wait, HP, mob targeting, linger and restore, refusals (scrolls, mode off), death → bags, owner pickup, lightning / tornado hooks, GM `transport` | **playable Trader loop**: walk a Donkey to the South Beach and sell; a monster pack kills it and the goods scatter | **4** |
| **4. Thieves and the law (server)** | `robbery.ts`: caravan pings, bags for Thieves, stolen crates, the den (Seopok, ring, scroll), robbery warrants and ladder through `law.ts` / `jail.ts`, recovery reward at Yun, pair rule, contact checks, `law_flags` rules; `ambush.ts` on looters; abuse tests | **the full war**: rob, flee, get captured, sit 15 min; or sell at the den | **4.5** |
| **5. Client core** | job window, NPC windows (Jodaesan, posts, Yun, Fang, Seopok), transport HUD, labels and rings, pings, `en-jobs.ts` | friends play a run with the real UI | **4** |
| **6. Client looks** | retail suits on adventurer bodies, licensed job palettes and emblem, transports (models, clips, stars), bags, post NPC dressing, world-map "Trade routes" layer | the user's go on the suits and the transport in the render lab | **3** |
| **7. Admin page and event** | "Jobs & Trade" panel (members, island map, market chart, run log, flags), the Silk Caravan event, load test | admin sees a run live; load gate | **3** |
| | | | **≈ 28.5** |

- Order: 0 → 1 → 2 → 3 → 5 gives the Trader loop (≈ 18.5); 4 adds the war; 6 and 7 can run beside 4.

### Layer 0–1 status (2026-10-08)

**Layer 0 (data and export), done.**
- `packages/convert/src/data/items.ts` `JOB_ITEM_CODE` exports, outside the degree limit: the 14 trade goods
  (`ITEM_ETC_TRADE_CH_01..07`, `WC_01..07`), the job suits (`ITEM_CH_M_TRADE_*`, the woman's `ITEM_CH_F_TRADE_*_02/_03`
  and `ITEM_CH_W_TRADE_*_04/_05(_01)` [confirmed itemdata: the woman's basic suits are `F`, not `W`]), the scrolls of
  the four transports (their `COS_T_DONKEY / HORSE1 / HORSE2 / DHORSE1` rows go to cos.json with icons) and the Bandit Den
  Return Scroll. `content.ts` keeps them out of the retail shops and drop tables. Models converted: the four transports
  (41 joints, 6 clips each), 16 suit models, `drop_trade` (already there); job UI art: `chr_job`, `chr_job_window`
  (the gauges and the job slot were already exported).
- Commands (run in this order; all write under `work/`):
  `pnpm tsx packages/convert/src/tools/export-data.ts` →
  `pnpm sro convert <the glbs it lists as missing> res/cos/t_donkey.bsr res/cos/t_horse1.bsr res/cos/t_horse2.bsr res/cos/t_dhorse1.bsr` →
  `pnpm tsx packages/convert/src/tools/export-data.ts` (models resolve) →
  `pnpm tsx packages/convert/src/tools/export-ui.ts` →
  `pnpm tsx packages/convert/src/tools/optimize-out.ts run --files @<list of the new files + data/items.json, data/cos.json, ui/index.json> --precompress`
  (out-opt; `--precompress` matters: a stale `items.json.br` would serve the old list).
- Places: `trade-south-beach`, `trade-tomb-camp`, `trade-ferry-landing`, `trade-sea-cliffs`, `bandit-den` in
  content/places.json, snapped by `pnpm --filter @sro/server places --write` (GM `tp trade-sea-cliffs`).
- `content/jobs/jobs.json` (goods, posts with their traders and spots, den, transports) = `JOBS_CONTENT` in
  `packages/shared/src/jobs.ts` (a test keeps the two equal; the server reads the file, else the built-in copy).
  `jobs.ts` also holds the settings (`JOB_SETTINGS_DEFAULTS`, bounds, check / merge / prune), the pure rules (levels,
  suit tiers and codes, stars, margins, drift, den payout, job EXP per source, `joinRefusal`, `jobPvp`) and the protocol.
- **Suit tiers, corrected from the data**: I = `_02` (White flag / Identity card / Black suit), II = `_04_01` (the
  simple clothes; the Thief has none: `_02`), III = `_03` (Red flag / Special Identity card / Black devil suit). `_04` /
  `_05` are retail stat variants of `_02`'s model: unused.

**Layer 1 (jobs core, server), done.** `apps/server/src/jobs/` (`jobs.ts` GameplayModule `jobs` after `hunters`,
`job-store.ts`, `jobs-admin.ts`), migration **25**.
- Licences: `jobJoin {npc, job}` at Jodaesan (`trader` service), Old Fang (`thief`; installed even with the walls off,
  on an export that has Jodaesan) and Captain Yun (`hunter`: the existing `hunterLicence` path, so the siege's
  `hunter.minLevel / licenceGold / cleanDays` stay the Hunter's; Trader and Thief use `jobs.minLevel / licenceGold`).
  `jobLeave {npc}` at the job's NPC: refused in the suit, Wanted, jailed or as a revoked Hunter.
- One side per account [decision, refining §2.1]: joining the other side is **refused** while another character of the
  account holds a job of the old side (the message names them) instead of silently ending their jobs; then the 7-day
  side wait and the 3-day leave wait (both per account) apply.
- Job mode = `on_duty` for every job; `jobMode {on}` (Hunters: `HunterService.setDuty`, `hunterDuty` unchanged).
  `EntityState.job` / `entityUpdate.job` = `{job, level}` while on (null off); `jobState` to the owner. Off locked
  `mode.offLockMin` (Hunters: `hunter.offDutyLockMin`) after a PvP hit. `carrying` is the seam for layers 3-4.
- PvP: `PvpSide` gained optional `job / jobMode / inJobSafe`; `pvpAllowed` ends with `jobPvp` (opposite sides, both in
  job mode, neither in a safe area, the stockade, or the 12 m ring of a post or the den — the live Seopok and Old Fang
  entities are used when present). Refusal `safe_zone` in those places. Wanted / Hunter rows and the anti-collusion
  associates unchanged.
- Job EXP / levels: `addExp` / `setExp`; a credited wall capture = `exp.hunterWallCapture` (2,000); the Hunter's
  `rank` column = job level − 1 (badge 0-6; `HUNTER_LIMITS.rank` 6; level 7 "Warden of the Roads" added to the
  client's rank strings). With 2,000 per capture ranks 1-2 come at 1 and 3 captures as before, ranks 3-5 sooner (8, 18,
  35 captures instead of 10, 25, 60). Character EXP is never touched.
- Migration 25: `char_jobs.job_exp` (Hunters: rank r → the EXP of level r + 1; rank kept), `account_jobs` (every
  account with a Hunter on the `law` side), `job_settings`. The market / transport / trade_log / robbery columns of §9.3
  wait for layers 2-4 (their own migration).
- GM `job <name> [status|join <job>|leave|level <1-7>|exp <n>|mode on|off|side law|outlaw]`; `law hunter <name>
  licence` refuses a character with another job. Admin `GET /api/admin/jobs`, `PUT jobs/settings` (`baseRev`),
  `POST jobs/settings/reset`, `POST jobs/member` (one GM verb), admin-only, `gm_audit` command `job`.
  `jobs.enabled false` turns joining, suits and job PvP off; the Bounty Hunters keep the siege law.
- Client: only `installJobsContent` in the catalog (post traders' names) and `hunter.rank.6`; the job window, NPC
  windows and labels are layer 5.
- Tests: `packages/shared/test/jobs.test.ts` (rules, the PvP matrix exhaustively, joining, settings, content,
  protocol), `apps/server/test/jobs.test.ts` (licences, sides, leave waits, job mode, the live PvP matrix incl. towns
  and rings, capture EXP and ranks, migration 25, GM, admin, abuse: party / IP / alts, leaving with a warrant, in the
  suit, jailed or revoked, jobs off); the convert data tests updated for the job items.
- Parallel lanes (the 2 + 1 helper cap): server 1 → 2 → 3 → 4 in one lane; client 5 → 6 in the second after layer 1's
  protocol lands; layer 0's converter part can go to the asset lane.

### Layer 2–3 status (2026-10-08)

**Layer 2 (the market, server), done.** `apps/server/src/jobs/market.ts` (GameplayModule `market`, after `jobs`),
`jobs/trade-store.ts`, migration **26** (`market`, `market_account_day`, `transports`, `trade_log`).
- NPC service `market` on Jodaesan and the four post traders. `tradeMarket {npc}` → `market {post, rows}` (sell price
  here, buy price at the source, demand, buy multiplier, news). `tradeBuy {npc, good, crates, dest}`: a Trader in the
  suit, at the good's source, the own transport within `transport.ringM` (20 m) of the trader; refusals `not_job_mode`,
  `hold_full`, `stars_cap` (§3.2 cap), `buy_cap` (`trade.buyCapPerHour` per account, from `trade_log`), gold.
  `tradeSell {npc, good?, crates?}` at any trade point (the source pays 0.9 × its buy price). Prices crate by crate
  (shared `tradeBuyTotal` / `tradeSellTotal`): buys raise the source's multiplier (cap 1.30), sells lower the post's
  demand (floor 0.70), at most `drift.accountDayMax` per account and UTC day; both recover 3 %/h toward 1 (lazily, by
  `updated_at`). The day's news (×1.20) is rolled once per UTC day (job_settings row `market_news`).
- A sale with a profit: Trader job EXP (profit ÷ 10 × the stars' multiplier, stars of the load before the sale);
  escorting Bounty Hunters (party, suit, ≤ 50 m, another account, another IP; ≤ 2) get 40 %; a same-IP escort gets
  nothing and a `law_flags` row `escort_same_ip`.
- GM **`market`** (§9.5's `trade` is a client chat prefix): `status | price <post> <good> <demand> | buy <post> <good>
  <mul> | reset | news <post> <good>`. Admin: GET `jobs` adds `market` and `transports`; POST `jobs/market` `{post, good,
  demand?|buyMul?}` or `{reset: true}` (gm_audit command `job`).

**Layer 3 (transports, server), done.** `apps/server/src/jobs/transport.ts` (GameplayModule `transports`).
- A transport is a `Cos` entity (model = the tier's COS_T_* from cos.json; HP, hold, speed, price from jobs.json), one
  per character, never beside a horse. `tradeSummon {npc, tier}` at a trader (pays the tier's price) or the tier's scroll
  (`ITEM_COS_T_*`, item-use hook) within the ring of a trader; job level ≥ the tier's.
- It follows the Trader's breadcrumb trail (3 m crumbs, `gapM` 3 m behind; straight at him past `leashM`; stops and
  says so past `waitM`). `transportRide {on}`: ridden at its walk pace (mountSpeed), hits on the rider land on it, no
  attacks/sit/etc. while riding (the horse seams in mounts.ts). Snow season: −10 % outside town. `EntityState.stars` /
  `entityUpdate.stars`; `transportState` to the owner.
- Attacked while loaded by: monsters (AiHost `targetAny` / `targetsNear`: aggressive mobs acquire it on sight, it takes
  a basic attack against `TRANSPORT_COMBAT`), Thieves in the suit (`attack` on the cos; not associates, not recorded
  contacts, not in a town or a 12 m ring; × `hunter.pvpMul`; the Thief's suit locks as after PvP), lightning (`onStrike`,
  as a player) and tornadoes (on the ground over it: 20 % of each good's crates as bags along the path, once per
  tornado). No regeneration; GM heal only.
- Death: 60 % of each good (rounded down) as goods bags (`bag` / `bagGone` to job-mode players, staff and the owner;
  `thief.bagLifeMin`), the rest destroyed, `trade_log` `lost` / `robbed`; Thieves with ≥ 25 % of its HP get 200 × stars
  job EXP. The Trader's death: it waits `ownerDeathS` (30 s, a target), then dies the same way unless he is back alive
  within `waitM`. `bagPick {id}`: the owner or his party → back into the owner's transport (no transport: refused;
  Thieves' pickups and stolen crates are layer 4).
- Ambushes: on leaving the post where the load was bought, `ambushCount(stars)` groups (`ambush.perStar` [0, 0.5, 1,
  1.5, 2.5]) wait at 30-80 % of the straight road to the declared destination; passing one spawns 3-5 bandits 30 m off
  the road charging the transport (roster: the Climb's B5 Bandits, B7 / B8 past 1.6 km by danger, else the retail
  `MOB_CH_BANDIT*`); unkilled ones leave after `ambush.lifeMin` once out of a fight.
- Loaded: return scrolls (`loaded`), the suit off and leaving the job (`jobs.carrying`), `transportDismiss` (`loaded`)
  are refused. Logout: an empty one is dismissed; a loaded one lingers `lingerS` (60 s, a target), then stays saved in
  `transports` and returns where it stood at the next login (a relog inside the linger takes it over). The row is
  rewritten on every hold change and at most every 5 s of damage.
- New settings groups `transport` {leashM, waitM, lingerS, ownerDeathS, ringM, gapM} and `ambush` {perStar, groupMin,
  groupMax, fromPct, toPct, offRoadM, farKm, lifeMin}. GM `transport <name> [status|spawn <1-4>|load <stars> [dest]|kill|
  heal|dismiss]`, `ambush <name> [groups]`, `bag [status|clear]`.
- Protocol (additive): requests `tradeMarket`, `tradeSummon`, `tradeBuy`, `tradeSell`, `transportRide`,
  `transportDismiss`, `bagPick`; messages `market`, `transportState`, `bag`, `bagGone`; fail reasons `not_job_mode`,
  `wrong_side`, `stars_cap`, `hold_full`, `loaded`, `buy_cap` (client lines in `apps/game/src/i18n/en-jobs.ts`; the
  windows are layer 5). Skills (AoE or targeted) do not hit transports yet; basic attacks do.
- Tests: `packages/shared/test/jobs-trade.test.ts` (hold, drift, recovery, margins, stars, tiers, ambush counts and
  rosters, settings, protocol), `apps/server/test/jobs-trade.test.ts` (runs, refusals, caps, escorts, summon / follow /
  ride, monsters, lightning, tornado, death and bags, the Trader's death, linger and restore, ambushes by stars, Thieves
  and associates, GM, admin).

### Layer 6 status (2026-10-08): client looks, part 1

Render side only, driven by `EntityState.job` / `entityUpdate.job` and `.stars` (layer 1-3's). The pure part is
`apps/game/src/three/job-look.ts`; the world side `apps/game/src/world/features/job-looks.ts` (`window.__sroJobs`).
- **Licensed bodies** (§3.3): the worn outfit keeps its pieces; `outfitFromGear(equip, gender, job)` gives every piece
  the job (`GearPiece.job`), its palette row `jobPaletteRow` (MAIN / SECOND at tier I, + the job trim at II, + metal trim
  and the twill at III; leather and linen stay the gear's), its key `|j<job>l<level>`. Empty chest / legs / feet are
  filled with plain garment cloth in job mode. [decision] Thief III: oxblood cloth with the soot-black trim so the red
  still reads. **Emblem** sewn into the cloth by ClothDyePlugin (`SROJOB`, compiled only for job outfits): Trader a gold
  cash coin, Bounty Hunter a blue arrowhead on silver, Thief three black claw slashes on red; on the left breast (6 cm,
  the chest centre is a UV seam on both tops) from tier I and between the shoulder blades (8.5 cm) from tier II; the job
  level 1-7 as pips over it. Its spot is measured once per glb on the LOD0 TOP / LAYERING / FRONT_CLOTH / TAILS
  (`emblemAnchorsOf`: the uv and the uv → metres map of the hit triangle), carried in the outfit strip (`STRIP_W` 8 → 12).
  The far LOD and the crowd take the job colours, no emblem.
- **Retail bodies**: the 16 suits are now in the equipment export (`JOB_SUIT_CODE`, slot `chest`, skinned to the body
  skeletons; rerun `pnpm tsx packages/convert/src/tools/export-equipment.ts` on a server's data, then optimize-out).
  `retailSuitPlan`: the REPLACE suits (black suits, simple clothes) take the armour off; the ADD ones (the flags, the
  identity cards) come over it; an export without the rows keeps the gear (the label still shows the job).
- **Plates**: a job line "TRADER · Peddler" (gold), "BOUNTY HUNTER · Tracker" (blue), "THIEF · Pickpocket" (red) with a
  small emblem dot, for everyone; law.ts's Bounty Hunter badge shows only without a job line (one tag).
- **Transports**: the retail pack animals keep their side bags; the load's crates (`drop_trade`) pile on the pack saddle,
  1-6 by stars (`bundleCount`), riding the pelvis joint through its bind pose; the stars over the name.
- Not yet (layer 6, part 2): goods bags on the ground, post NPC dressing, the world map's "Trade routes" layer.
- Tests: `apps/game/test/job-look.test.ts`; `packages/convert/test/equipment.corpus.test.ts` (the suits).

### Layer 4 status (2026-10-08)

**Layer 4 (Thieves and the law, server), done.** `apps/server/src/jobs/robbery.ts` (GameplayModule `robbery`, after
`transports`), `jobs/robbery-store.ts`, migration **27** (`job_sacks`, `robbery_log`, `law_records.robberies /
last_robbery_at`). The bandit ambushes (§9.2's `ambush.ts`) were already built in layer 3 (transport.ts).
- **Sacks, not bag items** [decision, refining §5.2 / §6.4]: goods carried outside a transport live in `job_sacks` per
  character (kind `stolen` / `recovered` / `own`), never in the inventory, so no path can trade, stall, store or drop
  them; `jobSack {entries}` to the carrier (good, crates, the robbed Trader, the gold it is worth).
- **Bags** (`bagPick`): the owner or his party → the owner's transport; the owner **without a transport** → his own sack,
  sold by him at any trade point (`tradeSell` without a transport); a **Thief** in the suit → stolen goods; a **Bounty
  Hunter** in the suit → recovered goods; anyone else `not_owner`. Each bag carries a robbery id (`batch`: one transport
  death, one tornado, one carrier's death).
- **Robbery warrants** (law.ts, `warrants.reason = 'robbery'`): opened at a Thief's first pickup, bounty = the recovery
  reward (`robbery.recoveryPct` 25 % of the den value, raised with each pickup); `EntityState.robber` /
  `entityUpdate.robber` (the ROBBER line; WANTED stays the walls'), `lawState.wanted.robbery`, `wantedPing.robbery`, no
  server-wide notice. Bounty Hunters fight, net, subdue and capture robbers like the Wanted, anywhere but the Stockade and
  the den's 12 m ring (`safe_zone`). Closes `sold` (den) or `dropped` (death; new warrant statuses), `captured`, or lapses
  after `robbery.warrantOnlineMin` (30) online minutes (the goods stay sellable).
- **Capture** (hunters.ts / GM `law capture`; the anti-collusion rules unchanged: associates, contacts, pair, repeat,
  daily cap): the stolen goods are confiscated (`trade_log confiscated`), the account's robbery level +1 (one forgiven per
  `robbery.forgiveDays`), jail = `robbery.sentencesMin` 15 / 30 / 60 / 120 min (beside the wall ladder: the longer counts);
  a jailed character leaves job mode; captors get the bounty and 300 × the Thief's job level × 2 job EXP (a wall-breaker
  still 2,000).
- **The den**: Seopok's NPC service `den`: `denSell {npc}` pays `thief.denPct` of the base price × the pair multiplier, job
  EXP payout ÷ 8, the warrant closes `sold`; `denBuy {npc, count}` sells the Bandit Den Return Scroll (job level 3, the
  item's price); the scroll (given a use row on the server) warps a Thief beside Seopok, refused with stolen goods or in
  combat. Return scrolls are refused (`loaded`) with stolen or own goods; the suit off and leaving the job too.
- **Captain Yun** `yunTurnIn {npc}`: recovered goods for the recovery reward, inside `hunter.dailyBountyCap` (captures +
  turn-ins of the account in 24 h; `daily_cap` flag); no reward for goods of an owner the Hunter is associated with or
  met (`recovery_contact`).
- **Anti-collusion**: Thieves cannot pick bags of associates (party, guild, account, IP) or recorded contacts of the owner
  (`robbery_contact`); the **pair rule** per robbery: the same Thief account robbing the same Trader account within
  `robbery.pairWindowH` (24 h) is paid × (1 − `law.repeatPct`) per earlier robbery, nothing and no job EXP from
  `law.repeatMax` on (full, half, nothing; `robbery_pair`); a Hunter's kill of a Thief in the suit (300 × level job EXP)
  counts once per pair window (`thief_kill_pair`). All are `law_flags` rows.
- **Deaths**: whatever a character carries falls as bags (owner = the robbed Trader).
- **Caravan pings**: every `thief.pingSec` a Thief in the suit gets `caravanPing {id, x, z, r, stars, at}` for each loaded
  transport of ≥ `thief.pingMinStars` within 400 m (not his associates'); 120 m circles, 80 m from job level 5.
- **Skills on transports**: a Thief's attack skills target a loaded transport (its fixed defence, no statuses), his area
  skills reach the transports he may rob (`attackRefusal`), projectiles land on them.
- GM **`robbery`** `[status] | <name> [status|give <good> <crates> [stolen|recovered|own]|clear|ping]`; admin GET `jobs`
  adds `sacks`; the `thief` / `robbery` settings groups (already bounded) apply live.
- Protocol (additive): requests `denSell`, `denBuy`, `yunTurnIn`; messages `jobSack`, `caravanPing`; the fields above; NPC
  service `den`. The shared checker also gained the Climb's `climb` message (it had no entry).
- Tests: `packages/shared/test/jobs-robbery.test.ts` (pair rule, ladder, reward, pings, protocol, `climb`),
  `apps/server/test/jobs-robbery.test.ts` (pickup → ROBBER → subdue → capture 15 / 30 min, the den and its ring, the
  scroll, lapse, deaths, Hunters' kills and turn-ins, the owner's own sack, associates / contacts / pair rule / plain
  players, pings, single and area skills, GM, admin, relog).
- Left for layer 5: the client (Seopok's and Yun's windows, the sack and ROBBER display, caravan pings on the map).

### Layer 7 status (2026-10-08): the admin page and the Silk Caravan

**Admin page "Jobs & Trade"** (`apps/admin/src/pages/jobs.ts`, nav Live → Jobs & Trade; also the Events page's sub-page for
the Silk Caravan, routes `jobs`). Tabs: **Members** (filters job / job level / side / account or name; set the level,
revoke / restore the licence, clear the account's waits, suit off, leave, add a member; accounts and sides), **Market**
(per trade point: every good's demand and the source's buy multiplier with drift arrows, the price it sells for now incl.
news and the event, override one, reset all; the latest `trade_log` with a kind filter), **Transports** (an island plan
with the posts, roads, danger and the transports; list with HP, load, stars, destination; heal / kill / dismiss), **Robbery
& law** (open robbery warrants, goods outside transports, the job `law_flags` = collusion attempts with a pair count, the
`robbery_log`; jail, confiscate, revoke), **Settings** (the jobs on/off switch and every number / list of the jobs, mode,
trade, drift, thief, robbery, exp, storm, transport and ambush groups with default and bounds; live), **Silk Caravan**.
The 2026-10-08 look: `Dropbox/.../jobs/admin.png` (all six tabs, sample data).
- Routes added (admin only, `gm_audit` command `job` per write, `jobs-admin.ts`): GET `jobs` adds `memberInfo`, `trades`,
  `robberies`, `robbers`, `flags` (`JOB_FLAG_RULES`), `event`; POST `jobs/member` also `{revoke: days}` (Trader / Thief: own
  days, the suit comes off and `jobMode` is refused until it runs out; Bounty Hunter: the siege's `law hunter revoke`),
  `{restore: true}`, `{resetWaits: true}`; POST `jobs/transport {character, action: heal|kill|dismiss}`, `jobs/robbery
  {character, action: clear|jail, minutes?}`, `jobs/event/start {minutes?, post?}`, `jobs/event/stop`.

**The Silk Caravan** (§8; `apps/server/src/jobs/caravan.ts`, GameplayModule `caravan` after `robbery`), **off by default**.
- Settings group `event` grew: `slots` [{6, '20:00'}], `tz`, `demand` 1.4, `expMul` 1.25 (Trader sale job EXP), `escortMul` 1.5,
  `ambushMul` 1.5 (expected groups per star), `denMul` 1.2, `rewardGold` 5,000 per **completed run** (a profitable sale from
  a transport away from the post the load was bought at), at most `rewardRuns` 3 per character per event (`trade_log`
  `caravan`), `busyWaitMin` 30; all bounded, slots / tz checked like the siege's.
- One far post (danger ≥ 4: Ferry Landing or Sea Cliffs, random, or named) is boosted. A server-wide `notice` (the
  NoticeBanner, from "Silk Caravan") and a chat line at start and end; players entering during it get a chat line.
- Never during a siege or a Night of the Tiger: a due slot waits `busyWaitMin` then is skipped; a manual start is refused;
  one starting mid-event ends it `interrupted`. A slot > 30 min late is skipped. State and the last 20 events in
  `job_settings` row `caravan_event`; a restart resumes a running event.
- GM `caravan [status] | caravan start [minutes] [post] | caravan stop`. Events page entry `silk-caravan`.
- Not done: the 7-day price chart and the load gate of §12 (tick p99 with 30 transports) — later.
- Tests: `apps/server/test/jobs-admin.test.ts` (403 for GM / player, the view, member / transport / robbery actions and
  their audit, settings checks, admin and GM start / stop, the boosted price, EXP, capped reward, ambushes ×, the den ×,
  the weekly slot, siege delay / skip / interrupt, restart); module-order lists in `modules.test.ts`, `social-seams.test.ts`.

### Polish status (2026-10-08): the gaps the layer helpers left

- **Follow / Stay here**: request `transportFollow {on}` (transports.ts `setFollow`; rate 2/s): `on: false` halts it where it
  stands (no follow steps; still a target while loaded), `on: true` back on the trail; refused while ridden (`mounted`),
  boarding clears it, a restored transport follows. `TransportView.staying` (optional, sent only when true; the client's
  parser keeps it). Client: a Follow / Stay here button between Ride and Dismiss on the transport frame, "Staying here"
  in its line (`transportFollow` in jobs-logic.ts).
- **Goods bags on the ground** and **the posts' dressing**: `apps/game/src/world/jobs/trade-world.ts` (TradeWorldView,
  driven by job-looks.ts: `bag` / `bagGone`, posts within 250 m): a stack of 1-3 retail goods crates (`drop_trade`) per
  bag; each of the four outer posts gets a corner of retail world props placed relative to the trader's spot and facing
  (`POST_PROPS`: the Jangan street stall `cj_streetstall` behind him, a straw cart `cj_strawcart` or the oasis wagon
  `oas_tarim_wagone` beside, `cj_potato_basket`, stacks of goods crates in front). Props stand on the lowest ground of
  their footprint and are snapped again as the terrain streams in; not pickable, no collision, nav untouched.
  `__sroJobs.world()` lists what is drawn. Jodaesan (in the town market) gets nothing.
- **The suit-off bug** (a Thief released from jail, suit off, drawn with no gear): not the jail. Every new character
  wears the starter set `ITEM_CH_*_CLOTHES_01_*_A_DEF`, and licensed-outfit.ts' `ARMOUR_RE` did not accept `_DEF`, so a
  licensed body drew the lingerie for it; in job mode the suit's plain fill (`JOB_FILL`) hid that, so the gear seemed to
  vanish whenever the suit came off (a jailing forces it off). Fixed in the regex (`(?:_DEF)?`); job-look.test.ts.
- **Load readability**: ten spots per pack saddle (2 × 2, three, two, one on top); bundles per stars 0-5 =
  `LOAD_BUNDLES` [0, 1, 3, 5, 7, 10] at `LOAD_SCALE` [0, 0.62, 0.74, 0.86, 0.96, 1.08] (one small bundle in the middle
  at one star, ten big ones piled ≈ 0.37 m higher at five), plus the stars over the name.
- **Balance** (measured by `apps/server/test/jobs-balance.test.ts` on the real export: a standard character of the level,
  STR build 20 + 4/level, the best sword, shield and light set it may wear; seconds for the Smash rotation – basic
  attacks only). Before: the transports' fixed defence 60 against `hunter.pvpMul` 0.5 left a level-20 Thief at 87-159 s
  on a Donkey (level 15: 222-716 s) and a Bounty Hunter at 100-293 s on a robber. New settings (Settings tab, live):
  `transport.thiefDefence` [15, 15, 20, 45] per tier (players only; monsters keep TRANSPORT_COMBAT's 60),
  `transport.thiefMul` 0.5 (instead of pvpMul), `robbery.hunterMul` 3 (an on-duty Bounty Hunter's hits on a robber;
  the siege's Wanted keep pvpMul; the robber's hits back stay × pvpMul).

  | Level (attack, HP) | Donkey 2,500 | Horse 3,800 | Thoroughbred 5,000 | Ironclad 7,000 | Robber subdued |
  |---|---|---|---|---|---|
  | 15 (63-69, 1,002) | 76-111 s | 115-169 s | 164-247 s | 381-727 s | 16-50 s |
  | 20 (85-94, 1,398) | 47-66 s | 71-101 s | 99-142 s | 189-303 s (3 Thieves ≈ 63-101 s) | 17-49 s |
  | 25 (116-127, 1,865) | 29-40 s | 44-60 s | 61-83 s | 106-153 s | 16-37 s |

- **"Trade routes" world-map layer**: worldmap.ts gained named overlay layers (`addWorldMapOverlay(fn, {id, label})`,
  toggles at the map's top left, on by default) and label-only shapes; jobs.ts' layer (`tradeRouteShapes`): the road from
  Jangan to each post coloured by danger with the profit per crate at normal demand after the tax (`routeProfitPct`:
  South Beach +5 %, Tomb Camp +8 %, Ferry Landing +17 %, Sea Cliffs +21 %), the posts and the Bandit Den.
- What's new: `content/changelog/2026-10-08-jobs.md` (7 images). The look: `Dropbox/.../jobs/polish.png`.
- Still open: the 7-day price chart and the load gate (30 transports) of layer 7.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Trade gold floods the Climb's tight economy (CLIMB.md §4.5) | margins 8-24 %, stars capped by job level, single-use summon items and the 3 % tax as sinks, drift; `trade_log` and the admin chart to watch gold per hour; every number is a setting |
| Too few players for a three-way war | ambushes and monsters make runs risky without Thieves; Hunters still have walls; the event concentrates players |
| Thieves camp the posts or the den | 12 m safe rings; four posts plus Jangan to choose from |
| Transports stuck on the nav (no pathfinding, `ai.ts` straight chords) | the transport follows the Trader's own path points (a breadcrumb trail), never its own pathing |
| The rename lane changes Hunter strings at the same time | this spec edits no i18n; layer 1 maps rank names after the rename has merged |
| Another lane takes migration 25 | renumber at merge |

## 14. Open questions (each with the default chosen)

1. Job level to join: **15** (retail 20 [unknown]).
2. Player-facing Hunter name: **"Bounty Hunter"** (one string to make it "Hunter").
3. Ride the transport: **yes, at its walk speed**.
4. Sea route: **not in v1**; a ferry crossing NPC later.
5. Robbery sentences: **15 / 30 / 60 / 120 min**, separate from walls.
6. Safe rings at posts and the den: **12 m**.
7. Stolen goods at the den: **60 % of base**; drop share **60 %**.
8. Weekly Silk Caravan: **designed, disabled by default**.
9. Names of the four post NPCs (Haeun, Gong, Wol, Mok): placeholders for the user to rename.

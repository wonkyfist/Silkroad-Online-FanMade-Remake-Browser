# Deploying to the mini PC

> **Public release note.** This page describes the original private setup (a small Linux "mini PC" on a Tailscale
> network). Its host details are placeholders here: `<SERVER_TAILNET_IP>` is your server's private/Tailscale IP,
> `<SSH_USER>` the SSH login user on it, `<your-machine>` its Tailscale machine name. Set them through
> `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_BIND` (see "Configuration" below and the README).

The game server runs on the mini PC (Omarchy/Arch, Intel N100, Tailscale `<SERVER_TAILNET_IP>`, Tailscale name
`<your-machine>`) as a **systemd user service** of `<SSH_USER>`. It needs no sudo and no system
packages. One command from this PC ships the committed code and the converted assets, restarts the server
and health-checks it.

Friends play at **http://<SERVER_TAILNET_IP>:7000/**, which is reachable only over Tailscale. Over plain http the browsers
give no WebGPU, so everyone is on WebGL2 until HTTPS is set up (see "HTTPS via Tailscale" below).

## Everyday commands

Run these from the repo root on the Windows PC (Git for Windows must be installed; `pnpm run deploy` finds its bash):

```sh
pnpm run deploy                      # code (git HEAD) + assets, restart, health check
pnpm run deploy -- --skip-assets     # code only
pnpm run deploy -- --assets-only     # assets only (restarts only if something changed)
pnpm run deploy -- --verify-assets   # re-hash the assets on the mini PC instead of trusting its manifest
pnpm run deploy -- --rebuild         # reinstall and rebuild even though HEAD is already deployed
pnpm run deploy -- --status          # what is deployed, service status, health
pnpm run deploy -- --rollback        # back to the previous release

pnpm deploy:gm grant <username> [--role gm|admin]
pnpm deploy:gm revoke <username>
pnpm deploy:gm list
pnpm deploy:gm audit [--limit N]
```

- **Use `pnpm run deploy`, not `pnpm deploy`.** `pnpm deploy` is a built-in pnpm command that ignores the script.
- `bash deploy/deploy.sh [options]` and `bash deploy/gm.sh ...` do the same from Git Bash.
- **Only committed code is deployed** (`git archive HEAD`). Uncommitted edits are never shipped; the script warns when there are some.
- A re-deploy of the same commit skips the code step. Assets are sent only when their SHA-256 changed.

## What the deploy does

1. **Tooling.** `deploy/remote/*` is copied to `~/silkroad/bin/`.
2. **Code.** `git archive HEAD` (about 1 MB gzipped) is unpacked into `~/silkroad/releases/<UTC time>-<commit>/`. Then `install.sh prepare` runs on the mini PC:
   - it installs Node and pnpm with mise, at the versions the repo pins (`.npmrc` `use-node-version`, `package.json` `packageManager`; `mise.toml` repeats them);
   - it runs `pnpm install --frozen-lockfile`;
   - it runs `pnpm --filter @sro/game build`.
   The pnpm store is shared, so later installs take seconds.
3. **Assets.** For each tree in `DEPLOY_ASSET_TREES` (`work/out` and `work/out-opt`), `deploy/assets.ts` hashes the local files. The hashes are cached by size and mtime in `work/.deploy/`. It then compares them with `~/silkroad-assets/<tree>/.deploy-manifest` on the mini PC.
   - Only new or changed files are sent (`tar | gzip -1 | ssh`), and files that are gone locally are deleted remotely. No rsync is needed.
   - `DEPLOY_ASSET_EXCLUDE` (`deploy/config.sh`) leaves out the converter's `debug/`, `test/` and `blender-ref/` folders, part of the remastered textures and the Meshy review staging (see "Remastered textures" below).
   - `--verify-assets` re-hashes the remote files (`sha256sum`) instead of trusting the stored manifest.
4. **Activate.** `~/silkroad/current` is switched to the new release. `silkroad.env` and the unit are (re)written, and the service is restarted. Then `/health` must answer within 30 s. If it does not, the previous release is put back and restarted, and the deploy fails. Only the last 3 releases are kept (`DEPLOY_KEEP_RELEASES`).
5. **Health check** from this PC: `/health`, `/` (the game client) and `/out/index.json` (the assets).

The retail-derived assets travel only over the SSH connection inside the tailnet. They never go into git.

## What is where on the mini PC

| Path | What |
|---|---|
| `~/silkroad/releases/<release>/` | Code of one release (`.deploy-sha` = commit; `.deploy-env` = the Node/pnpm binaries it uses; `.deploy-*.log` = install/build logs) |
| `~/silkroad/current` | Symlink to the live release |
| `~/silkroad/bin/` | `install.sh`, `start.sh` (the service's ExecStart), `gm.sh`, the unit file |
| `~/silkroad/silkroad.env` | Service environment, **rewritten on every deploy** (`NODE_ENV=production`, `HOST=<SERVER_TAILNET_IP>`, `PORT=7000`, `DATA_DIR`, `OUT_DIR`, `OUT_OPT_DIR`, `GAME_DIST`) |
| `~/silkroad/silkroad.local.env` | Your own settings (e.g. `LEVEL_CAP`, `CAPACITY`; see `apps/server/README.md`). They override `silkroad.env` and are never touched by a deploy |
| `~/silkroad-data/game.db` | The SQLite database (accounts, characters, items) |
| `~/silkroad-data/world-clock.json` | The world clock a GM set with `/time` (absent = the `DAY_*` defaults; see "Day, night and weather") |
| `~/silkroad-assets/out/` | `work/out`, served at `/out/` (`OUT_DIR`) |
| `~/silkroad-assets/out-opt/` | `work/out-opt`, the slimmed copy (`OUT_OPT_DIR`) for when the loaders read it |
| `~/.config/systemd/user/silkroad.service` | The user service (`deploy/remote/silkroad.service`) |
| `~/.local/share/mise/installs/{node/24.21.0,pnpm/10.34.4}` | Node and pnpm from mise |

The server runs as `node --import tsx src/main.ts` from `apps/server` of the current release. It is the service's main process, so SIGTERM (stop/restart) makes it save every position before it exits.

## One-time steps for the owner

1. **Keep the server running when you are logged out, and start it at boot.** User services stop when the last session of `<SSH_USER>` ends unless lingering is on. Run once on the mini PC:
   ```sh
   sudo loginctl enable-linger <SSH_USER>
   ```
   Every deploy prints a note while lingering is off.
2. **Your GM account.** Open http://<SERVER_TAILNET_IP>:7000/ and register your account (e.g. `yourname`) on the login screen. Then, on this PC:
   ```sh
   pnpm deploy:gm grant yourname        # or: --role admin
   ```
   A connected client gets the role within about a second. Roles change only through this CLI (never in-game).
3. **Invite friends to the tailnet.** The server listens only on the Tailscale address, so a friend needs Tailscale and access to the mini PC:
   - Recommended: in the Tailscale admin console, open **Machines**, then the mini PC's `...` menu, then **Share...**. Send the invite link. The friend signs in to Tailscale with their own account and accepts. They see only this machine, at the same address.
   - Or invite them as users of your tailnet (**Users**, then **Invite users**). Your ACLs then decide what they can reach.
   - They then open **http://<SERVER_TAILNET_IP>:7000/**, register an account and play. Registration is open to anyone who can reach the port, which is why the port stays on the tailnet: do not port-forward it.

## Operating it

Run these on the mini PC, or from this PC with `ssh -i ~/.ssh/sro_deploy <SSH_USER>@<SERVER_TAILNET_IP> '<command>'`:

```sh
systemctl --user status silkroad
journalctl --user -u silkroad -f                 # logs
systemctl --user restart silkroad                # e.g. after editing ~/silkroad/silkroad.local.env
sqlite3 ~/silkroad-data/game.db ".backup $HOME/silkroad-data/backup-$(date +%F).db"   # safe while running
```

## Playing on the fields around Jangan (`WORLD_EXPORT`)

The server simulates the export folder named by `WORLD_EXPORT`. Since wave 3 (W3-I) the deploy plays **`jangan-fields`** (307 regions: the whole levels 1–20 area, which the client streams region by region): `deploy/config.sh` sets `DEPLOY_WORLD_EXPORT=jangan-fields`, and every deploy writes `WORLD_EXPORT=jangan-fields` into `~/silkroad/silkroad.env` once `~/silkroad-assets/out/world/jangan-fields/` exists. Without that line the server picks the same default itself when the folder is there, and the 3 × 3 town export `jangan` otherwise. `jangan-near` (the 5 × 5 regions around town) also exists. The world id stays `jangan`, so accounts, characters and positions are kept when you switch in either direction (apps/server/README.md, "World exports").

**What the deploy syncs.** Nothing extra to do: both asset trees are synced whole, so `work/out/world/jangan-fields/`, `work/out/world/jangan-near/`, their slim copies in `work/out-opt/world/` and `work/out/data/zones.json` go along with every asset deploy. The first sync after they were exported is large (about 460 MiB from `work/out` and 280 MiB from `work/out-opt`); later deploys send only changed files. A code deploy that runs before that first sync leaves `WORLD_EXPORT` out; the restart after the asset sync writes it.

**Check it** after a deploy:

```sh
journalctl --user -u silkroad -n 40 | grep -E 'navigation|world content|nests not spawned|listening'
```

The log should show `nav.bin (307 regions, 2233 objects` (2281 before the wave-10 coast), about `700 nests` and `6083 monsters spawned`, one `nests not spawned: 91 unreachable on foot from town` line (the Western China fields across the river; no ferry teleport yet), and `listening ... (world jangan from export jangan-fields`. The client picks the folder up from the server (`ServerInfo.world`), so players only need to reload the page. Expect about 750 MB of memory for the server instead of about 310 MB. Optional: `NEST_COUNT_SCALE=0.5` in `silkroad.local.env` halves the monsters per nest.

**Back to the town map.** Add `WORLD_EXPORT=jangan` to `~/silkroad/silkroad.local.env` (it overrides `silkroad.env`) and `systemctl --user restart silkroad`; or deploy with `DEPLOY_WORLD_EXPORT=jangan`. A character saved outside the smaller map is moved to its edge (the nearest open ground there), or to the town gate when there is none.

## Wave 10: the coast re-convert, the jump packs and the notices file

**Nothing new to configure.** Every wave-10 asset lives under the two synced trees, so the next asset deploy sends it:
the coast field (`world/jangan-fields/coast/field.png`, in `out` and `out-opt`), the re-converted `jangan-fields`
export (414 regions: 307 playable + 107 synthetic coast regions, the new terrain, `nav.bin`, the static tree variants,
the tile grass palettes), the movement packs (`char/_anims/*/movement.glb` and `.json`) and `slim.json`. The first
sync after the re-convert is large (most terrain and minimap files changed); later deploys send only changed files.

**The re-convert needs a server restart** (the deploy restarts it): the coast moved terrain and nav, so a server still
running the old `nav.bin` places players at the old heights on the beaches. Players reload the page after it (a page
left open keeps the old terrain in memory, COAST Q13). A character saved on the old 0 m strip at the south beach (S1)
logs in on the new ground: `entryPoint` re-places it with `nav.place` (checked in I-10R: five points saved on the old
strip came back where they were, three on the dry sand, one at the waterline and one on the slope behind; none moved to
town). S1 is walkable from town without GM through its in-bounds link (checked in
I-10R by a non-GM client: 2.0 km, about 6 minutes on foot). `/tp beach-south` takes a GM there.

**THIRD_PARTY_NOTICES.md** (the MIT notice of the ported Tidewater ocean code, COAST §8.12) ships with the client:
the game's Vite build emits it into `apps/game/dist/` (the `sro-third-party-notices` plugin in
`apps/game/vite.config.ts`), so the mini PC's build serves it next to the game files. Check after a deploy:

```sh
curl -sI http://localhost:7000/THIRD_PARTY_NOTICES.md | head -1
```

## Wave 11: Tiger Girl as a world boss, the living town (`UNIQUES`, migration 10)

**Back up the database first.** Wave 11 adds **migration 10** (the `uniques` table: one row per unique with its phase,
next spawn time, camp and last killer). The server runs it by itself at start, but a downgrade is not supported, so
take the backup from "Operating it" before the deploy:

```sh
sqlite3 ~/silkroad-data/game.db ".backup $HOME/silkroad-data/backup-$(date +%F)-pre-w11.db"
```

I-11 rehearsed this on a copy of the dev database rolled back to schema 9: the server raised it to 10 at start, made
the table, and kept every account and character (13 and 14 before and after).

**One new setting, `UNIQUES`** (`on` by default, or `off`). On: Tiger Girl is a world boss: one alive at a time at one
of her 11 camps, 10 to 30 minutes after the first start, then 3 to 6 hours after each kill, with the timer kept across
restarts. A restart while she is alive brings her back 1 to 2 minutes after the boot at a new roll. Every player in the
world gets the appear and defeat banners. Off: today's behaviour (her nests spawn her as a plain monster, no notices,
`/unique` answers "Uniques are off"). GMs: `/unique list | spawn tiger [here | camp <id>] | kill | despawn | timer |
quiet` (docs/UNIQUES.md §3.9; every use is audited).

**What the asset deploy sends** (all under the two synced trees): `data/mobs.json` (Tiger Girl's `ride`) and
`data/items.json` (the `_RARE` rows), the Blue Tiger (`mob/china/bluetiger.glb`, 86 KB brotli, fetched on first sight),
the town's crowd (`town/`: 29 dressed variants, 12 VATs, about 15 MB in `out`, loaded on Medium and up only), the
re-converted `jangan-fields` export (the dressing placements, the cloth pivots, `town.json`, `town-dressing.json`,
`town-decals.json`, the lamp rows in `ambient.json`) and the sound export (the two unique cues and the town's 20
synthesized files). Low downloads only the town's bed and bell sounds.

**Server and client go together** (WAVE_PLAN7 D32): the new server sends `uniqueNotice`, which an old client warns
about and drops. Tell friends to **reload the page** after the deploy (a page left open keeps the old town and never
shows the banners). The town itself needs nothing from the server: every client computes the same townsfolk from the
shared clock.

## Wave 12: the World Editor, the remastered terrain, the new trees (no migration)

**No migration, no new setting, no wire message.** The manifest only gains optional fields (`WorldPlacement.scale`,
`WorldModel.treeSwap`, per-region grass masks and light points); a client left open on the old page ignores them and
keeps the retail trees. Tell friends to **reload the page** after the deploy, as every wave.

**What the asset deploy sends** (about **+237 MB** on the mini PC, measured at V-12 on the X3 export; I-12 measured
+212 MB on X2, the plan said ≈ +171): the 92 terrain texture sets encoded this wave (`out-opt/pbr/tile2d/`, ≈ 181 MB as WebP, the KTX2 masters stay
excluded), the 35 tree species (`world/jangan-fields/models/trees/` in both trees, ≈ 25 MB, plus their texture sets
under `out-opt/pbr/prim/.../tre_w12_*`, ≈ 6 MB), and the re-converted export (`manifest.json` with `treeSwap` on 106
retail tree and plant models, 130 rows with the static variants). The retail tree glbs stay: Low and the Options row *Trees: Retail* draw them.
**Not sent:** the tree tool's work products (`out/trees/`, `out-opt/trees/`, ≈ 400 MB of sheets, sprite masters and LOD
drafts: `out:trees,out-opt:trees` in `DEPLOY_ASSET_EXCLUDE`) and the editor's staging exports (`world/*-edit`).

**The w12r mini-wave on top** (re-converted and optimized at its gate, 2026-10-03; deployed with wave 12): the plaza's
new dragon and fountain basin (`models/bldg/china/jangan01/cj_jang_gate{,_dragon}.remaster.{glb,json}` and
`lightmaps/remaster/plaza/`, 1.2 MB in out-opt) and the dragon's gold set (`out/remaster/sets/jangan_dragon_m1/`,
3.9 MB), the retail texture scroll in 21 sidecars (`uvScroll`, a few bytes each), the GM teleport list
(`content/places.json`, server side) and TREE-TUNE's re-encoded species sets (`out-opt/pbr/prim/.../tre_w12_*`; 17
unused species keys removed). No migration and no new wire message: the key walk (W A S D) reuses `moveTo`, and the
new Options rows (Keyboard movement, Light shafts) default from old saves.

**Players' cost:** Medium downloads ≈ +3 MB on first entry to town and its video memory grows ≈ 40–50 MB; High
WebGPU uses ≈ +0.3 GB more video memory (the terrain's 1024² set planes). Low is unchanged.

**The World Editor is never deployed.** The mini PC builds only `@sro/game` (`deploy/remote/install.sh`); the editor
is `pnpm editor` on this PC (docs/EDITOR_GUIDE.md). Its **Deploy** button runs this same deploy in its assets-only mode
(`pnpm run deploy -- --assets-only`) and refuses while a Publish is open, while nothing new was kept, or while the
converter code is uncommitted or newer than the deployed release (`apps/viewer/editor-api/deploy.ts`): a map edit ships
with code the server already runs, or with the next release. `content/world-edits/jangan-fields/` ships empty (the
palette only): the first real map edit is yours.

## Game rates (`EXP_RATE`, `SP_RATE`, `GOLD_RATE`, `DROP_RATE`)

All four default to `1` (retail numbers). To speed the game up, put them in `~/silkroad/silkroad.local.env` and `systemctl --user restart silkroad`; a deploy never touches that file. For example:

```sh
EXP_RATE=3
SP_RATE=3
GOLD_RATE=3
DROP_RATE=2
```

`EXP_RATE`/`SP_RATE` multiply kill EXP and SP-EXP, `GOLD_RATE` dropped gold, `DROP_RATE` item drop chances; quest rewards are never rated. The math behind these values (time to level 20, potion budget, SP per level) is in `docs/BALANCE.md` §7. A bad value (negative, not a number, over 1000) stops the server at startup with a message naming the variable, so check `journalctl --user -u silkroad -n 20` after the restart.

## Day, night and weather (`DAY_*`, `WEATHER*`)

The server keeps one world clock and one weather for everyone (docs/SKY.md §2, docs/WEATHER.md §2). All six keys are optional; put them in `~/silkroad/silkroad.local.env` and `systemctl --user restart silkroad`:

| Key | Default | Range | Meaning |
|---|---|---|---|
| `DAY_LENGTH_MIN` | `120` | 1–1440 | Real minutes per game day |
| `DAY_NIGHT_SPEEDUP` | `0.4` | 0–0.6 | How much faster the night passes (0.4: the sun is down 41 of 120 minutes, fully dark about 37) |
| `DAY_SEASON_DEG` | `12` | −23.44–23.44 | The season, as the sun's declination (+ = summer: longer days, a higher sun) |
| `WEATHER` | `auto` | `auto`, `off`, `clear`, `cloudy`, `overcast`, `rain`, `storm`, `fog` | `auto` follows the seeded schedule; `off` is always clear and sends nothing; a state name fixes that weather |
| `WEATHER_SEED` | `1` | 0–4294967295 | Seed of the schedule (another seed, another sequence of days) |
| `WEATHER_RAIN_SCALE` | `1` | 0–3 | Multiplies the chance of rain and storms (2 ≈ 20 % rain; 0 = never) |

The clock and the schedule are deterministic, so a restart keeps the same time of day and the same weather. A GM's clock changes (`/time …`) are saved in `~/silkroad-data/world-clock.json` (the server's `DATA_DIR`) and win over the `DAY_*` keys until `/time reset` deletes that file; weather holds (`/weather …`) end with a restart. A bad value stops the server at startup with a message naming the key.

## Remastered textures (the `pbr/` tree, wave 9B)

The game swaps the retail textures for the texture pipeline's remastered sets a moment after a region, a model or a
character appears (docs/WAVE_PLAN3.md §7.1 lane TX-R). It reads them under its world root, `/out-opt/pbr/`
(`index.json` plus `<key>/<map>@<tier>.webp`), which `optimize-out` copies from `work/out/pbr/`. Options → Graphics →
Textures picks the tier (only with the new look on); it applies after a reload:

| Tier | Preset (Textures "Auto") | What loads |
|---|---|---|
| Classic | Low, and every preset without the new look | nothing: the retail textures |
| Remastered | Medium | the retail-size remaster, with normal and ORMH maps for the hero sets |
| up to 1024 | High | the '2x' tier (twice the retail size, at most 1024) and its maps; the terrain's set tiles at 1024 on WebGPU |
| up to 2048 | Ultra | the KTX2 masters when their transcoder is deployed, else High's textures (D39; an explicit 2048 texture setting still takes the WebP tiers up to 2048) |

What a deploy sends (`DEPLOY_ASSET_EXCLUDE`), measured on the 145 hero sets of batch B1 (2026-09-29):

| Path | Size | Sent | Why |
|---|---:|---|---|
| `out-opt/pbr/**/*.webp` + `index.json(.br)` | 153.4 MB, 2,196 files | yes | every WebP tier the presets use (the 2048 tier is 87 MB of it: only an explicit 2048 texture setting loads it without KTX2; consider holding it back until KTX2 ships) |
| `out-opt/pbr/**/*.ktx2` | 551 MB, 435 files | no | the Ultra masters; only worth sending once someone plays on Ultra |
| `out-opt/_decoders/ktx2/` | 0.7 MB | no | their transcoder: without it the game never asks for a `.ktx2` and Ultra takes High's textures (D39). Send both or neither |
| `out/pbr/` | 154 MB | no | the pipeline's working copy; the game reads `/out-opt/pbr/` |
| `out/remaster/manifest.json` + `out/remaster/sets/` | 30.8 MB, 49 files | yes | the 12 Meshy sets the user approved on 2026-09-29 (6 clothing pieces, 6 bodies with the local face): every page loads the manifest, and each entry wins over the pipeline's set for the same image (D35) |
| `out/remaster/sets/jangan_dragon_m1/` (in the manifest since 2026-10-02) | 3.9 MB, 8 files | yes | the Jangan plaza dragon's gold set (DRAGON-INT, docs/REMASTER.md §8): Medium and High load the three @1024 maps (1.05 MB), Ultra the 2048 ones; it applies once the export carries the dragon's remaster variant (`out-opt/world/jangan-fields/models/bldg/china/jangan01/cj_jang_gate{,_dragon}.remaster.{glb,json}` and `lightmaps/remaster/plaza/`, about 2.9 MB of glbs before optimize-out) |
| `out/remaster/staging*`, `out/remaster/manifest.before-*` | 31 MB | no | the Meshy review staging (`staging.json` stays the record of what was reviewed) and an old manifest backup |
| `out-opt/remaster/` | (none now) | no | `optimize-out` copies `out/remaster/` here; the game reads `/out/remaster/` first, so the copy is never read |

- **First deploy with the sets:** about 153 MB more to send (WebP barely gzips), once; later deploys send only changed
  files. The mini PC needs the same on disk. The first deploy of the Meshy sets adds 31 MB once.
- **The Meshy sets on a player's machine:** each part is a 2048² albedo, normal and ORMH (about 67 MB of video memory
  with mips, on every PBR tier: the manifest lists no smaller sizes); a friend downloads a part (1–4 MB) the first time
  a character wearing it appears. `?remaster=0` leaves them out for one page load (an A/B against the pipeline's sets).
- **What a player downloads** (first entry, every hero set in view, from `pbr/index.json`): Medium ≈ 13 MB, High ≈
  37 MB (≈ 53 MB while the `out-opt` index has no '2x' tier, see below), Ultra ≈ 64–68 MB on WebP. The browser caches
  them. At 20 Mbit/s up from the host, High's 37 MB is about 15 s for one friend, spread over play: the retail look shows
  first and nothing waits for it.
- **Video memory** on High in the town (dev PC, the plaza, all 145 sets resident): object maps +168 MB (minus up to
  59 MB of retail textures freed), actors +28 MB, terrain +127 MB on WebGPU (the 1024 tier plane 85 MB, normal and ORMH
  21 MB each; the planes are as deep as the 16 set tiles, not the atlas' 96 layers) or +26 MB on WebGL2 (no tier plane:
  its sampler budget is full, so the set tiles stay at 512). About +0.3 GB in all, inside WAVE_PLAN3 §5.2's
  0.7–1.0 GB for the texture sets.
- **Keep `out-opt/pbr/` current:** run `optimize-out` after a texture batch before deploying (on 2026-09-29 the
  `out-opt` copy was the older B1 run without the '2x' tier, so High took the 1024 tier: more bytes, same look).
- **Turning on Ultra's KTX2:** remove `out-opt:pbr/**/*.ktx2` and `out-opt:_decoders/ktx2` from `DEPLOY_ASSET_EXCLUDE`
  (in `deploy/config.local.sh`); the next deploy sends ~552 MB once. The deploy deletes on the mini PC whatever the rule
  leaves out, so putting them back in the rule removes them again.

## HTTPS via Tailscale (needed for WebGPU)

Browsers expose WebGPU only in a **secure context** (HTTPS, or `localhost`). `http://<SERVER_TAILNET_IP>:7000/` is not one,
so every friend runs the WebGL2 engine today, whatever their GPU. The game is built to look and run right on both, but
the WebGPU path is the faster one on High and Ultra (docs/RENDER.md). The fix is `tailscale serve`, which gives the mini
PC a real certificate for its tailnet name, reachable only inside the tailnet as before:

1. In the Tailscale admin console, **DNS**: MagicDNS on, and **HTTPS Certificates** enabled (a one-time switch).
2. On the mini PC: `tailscale serve --bg http://<SERVER_TAILNET_IP>:7000` (the server's bind address and port). It survives
   reboots; `tailscale serve status` shows it and `tailscale serve reset` removes it. WebSockets (`/ws`) pass through.
3. Friends then play at `https://<your-machine>.<tailnet>.ts.net/` (the exact name is in `tailscale serve
   status`). The first visit may take a few seconds while the certificate is issued.
4. The server accepts its own origin (it compares `Origin` with the `Host` header). If the login or `/ws` is refused
   with "origin not allowed", add `ALLOWED_ORIGINS=https://<your-machine>.<tailnet>.ts.net` to
   `~/silkroad/silkroad.local.env` and restart.

The plain `http://<SERVER_TAILNET_IP>:7000/` keeps working (WebGL2) while friends switch. Nothing in the deploy changes.

## Configuration

`deploy/config.sh` holds the target: host, user, key, bind address, port, asset trees and exclusions, and releases kept. Override any value with an environment variable of the same name, or in `deploy/config.local.sh` (gitignored). For example, `DEPLOY_HOST=<your-machine> DEPLOY_USER=<SSH_USER> DEPLOY_BIND=<SERVER_TAILNET_IP> pnpm run deploy`. config.local.sh is sourced after config.sh, so it takes plain assignments (`DEPLOY_HOST=...`), and DEPLOY_BIND must be set there too. The public release ships placeholders (`YOUR_SERVER_PRIVATE_IP`, `YOUR_SSH_USER`), and the deploy refuses to run until they are replaced.

## Troubleshooting

- **`cannot reach ... over SSH`.** Check that Tailscale is up on both machines (`tailscale status`) and that `~/.ssh/sro_deploy` exists.
- **The health check fails after a restart.** The deploy prints the last 30 journal lines and rolls back. Look at `.deploy-install.log` / `.deploy-build.log` in the release directory.
- **The service does not come up after a reboot.** Lingering is off (see above). Or Tailscale was not up yet: the service retries every 5 s until the address exists.
- **Assets look stale.** Run `pnpm run deploy -- --assets-only --verify-assets`.

# Silkroad Online: Jangan (a fan-made browser remake)

A non-commercial, fan-made remake of the Jangan area of **Silkroad Online (vSRO 1.188)** that runs in the browser.
The game client, the game server, the converter and the World Editor were written from scratch in TypeScript
(Babylon.js 9 in the browser, Node 24 + SQLite on the server). It is a hobby project for playing with friends: nothing
is sold, there are no payments of any kind, and it is meant for private use.

**Not affiliated with Joymax.** Silkroad Online, its name, world, models, textures and sounds belong to their owners.
The converted assets in `work/out` and `work/out-opt` were made from an original vSRO 1.188 client for this private
project. Keep the repository private and do not redistribute the assets.

## What is included

| Path | What it is |
|---|---|
| `apps/game` | The browser game client (Vite + Babylon.js): login, character select and creation, the world, combat, quests, shops, UI |
| `apps/server` | The authoritative game server: HTTP account API, WebSocket game protocol, SQLite database (`apps/server/README.md`) |
| `apps/viewer` | The model/world viewer and the **World Editor** (`src/editor` is the UI, `editor-api` the local API behind it) |
| `packages/shared`, `world-render`, `nav`, `fx`, `appearance` | Code shared by the client, server, viewer and editor: protocol, renderer, navigation mesh, effects |
| `packages/formats` | Parsers for the retail file formats (PK2 archives and the rest), used by the converter |
| `packages/convert` | The converter and the `pnpm sro` CLI. The World Editor's Publish runs its incremental convert |
| `packages/texpipe` | Texture index tools. The World Editor uses them when hero tiles are painted |
| `content/` | The project's own data: quests, the town, coast, trees, texture overrides, and `world-edits/` (the map edits) |
| `work/out`, `work/out-opt` | The **converted game assets** the server serves, with the latest kept map edits (about 2.3 GB) |
| `work/out/pbr`, `work/out/trees`, `work/cache`, `work/editor/jangan-fields/base`, `work/remaster`, `work/texpipe/inventory.json` | Inputs the World Editor's Publish and Keep need on a fresh clone |
| `docs/` | Design notes and guides (start with `docs/EDITOR_GUIDE.md`, `docs/WORLD_EDITOR.md`, `docs/DEPLOY.md`) |
| `deploy/` | Optional scripts to host the server on your own Linux machine over SSH |

**Not included:**

- The original game client and its `.pk2` archives. You need your own vSRO 1.188 client only to **Publish** in the
  World Editor (or to re-run the converter). Playing and hosting need nothing beyond this repository.
- Any player database. The server creates a fresh `work/server/game.db` on first start.
- The one-off art pipelines: the ComfyUI/SDXL texture upscaling, the tree tool's authoring part and its Meshy client,
  and the Blender scripts. Their results are already in `work/out` and `content/`. Without them, `pnpm sro trees`,
  `pnpm sro coast-export`, `pnpm sro coast-import`, `pnpm sro moves` and `pnpm texpipe detail` do not work. Nothing
  else needs them.

## Requirements

- **Node 24** and **pnpm 10**. Run `corepack enable` once, and pnpm 10.34.4 is used (`packageManager` in
  `package.json`). pnpm then downloads the pinned Node 24.21.0 by itself (`use-node-version` in `.npmrc`).
  Always run Node through pnpm (`pnpm exec ...`, `pnpm tsx ...`).
- **Git**. On Windows, Git for Windows: the deploy scripts and the editor's Deploy button use its Git Bash.
- A desktop browser with WebGL2 (Chrome, Edge or Firefox). WebGPU is used when the page is on `localhost` or HTTPS.
- About 6 GB of free disk space for the clone and `node_modules`.

## Install

```sh
git clone <this repository> silkroad
cd silkroad
pnpm install --frozen-lockfile
```

No native build step is needed: `better-sqlite3`, `sharp` and `esbuild` come with prebuilt binaries.

Checks (optional):

```sh
pnpm typecheck
pnpm test          # tests that need the original client skip themselves without sro.config.json
```

## Run the game on your PC

Start the server and the client in two terminals from the repository root:

```sh
pnpm server        # the game server on http://127.0.0.1:7000 (restarts when its code changes)
pnpm game          # the client on http://localhost:5180 (Vite; it proxies /api and /ws to the server)
```

Open **http://localhost:5180**, register an account on the login screen, pick the server and create a character.

- On the first start the server creates `work/server/game.db` and runs its migrations. Accounts and characters live
  there; back it up if you care about them. Delete it (with the server stopped) to start over.
- The server reads the converted assets from `work/out` and `work/out-opt` and plays the `jangan-fields` world (the
  fields around Jangan).
- Settings are environment variables: `PORT`, `HOST`, `LEVEL_CAP` (20), `CAPACITY`, `EXP_RATE`, `DROP_RATE` and
  more. See `apps/server/.env.example` and the full table in `apps/server/README.md`. For example
  `EXP_RATE=2 pnpm server` (bash) or `$env:EXP_RATE='2'; pnpm server` (PowerShell).

### One port for friends (production mode)

Build the client once, then start the server in production mode. It serves the game at `/` and the assets at `/out`
and `/out-opt`, all on one port:

```sh
pnpm --filter @sro/game build
NODE_ENV=production HOST=<your private IP> PORT=7000 pnpm --filter @sro/server start
```

PowerShell: `$env:NODE_ENV='production'; $env:HOST='<your private IP>'; pnpm --filter @sro/server start`.

Friends then open `http://<your private IP>:7000/`. In production mode `HOST` defaults to `0.0.0.0` (every network),
so set it to a private address. Registration is open to anyone who can reach the port: keep the server on a private
network such as Tailscale or WireGuard, and never port-forward it to the internet. Browsers give WebGPU only over
HTTPS or on `localhost`; over plain http everyone plays on WebGL2 (`docs/DEPLOY.md`, "HTTPS via Tailscale").

### Make your account a GM

Register your account in the game first (the database must exist), then run:

```sh
pnpm gm grant <username>              # or: pnpm gm grant <username> --role admin
pnpm gm list                          # also: pnpm gm revoke <username>, pnpm gm audit
```

It works on `work/server/game.db` (or `DATA_DIR/game.db`) and is safe while the server runs: the player gets the role
within about a second. On a server hosted with the deploy scripts, use `pnpm deploy:gm grant <username>`.

## The World Editor

The World Editor is a local map editor for the Jangan fields: shape and paint the ground, plant trees and grass, and
place, move or delete objects, lights, water and sound zones. `docs/EDITOR_GUIDE.md` explains the tools and the keys;
`docs/WORLD_EDITOR.md` is the design.

### Start it

```sh
pnpm editor
```

It serves **http://127.0.0.1:5185** on this PC only and opens it in your browser. On Windows you can also double-click
`work/editor/Silkroad World Editor.cmd`. `SRO_EDITOR_PORT` moves the port and `SRO_EDITOR_NO_OPEN=1` keeps the browser
closed. Only one editor runs at a time.

### Point it at your own client (needed for Publish)

Editing and **Save** (Ctrl+S) work without the original client. **Publish** re-converts the regions you changed, so
it reads your own vSRO 1.188 client:

1. Copy `sro.config.example.json` to `sro.config.json` in the repository root.
2. Set `"clientDir"` to your vSRO 1.188 client folder, the one that holds `Data.pk2`, `Map.pk2` and `Media.pk2`.
   On Windows write the backslashes doubled, for example `"D:\\Games\\Silkroad"`. Keep `"pk2Key": "169841"` and
   `"workDir": "work"`.

`sro.config.json` is gitignored; never commit it, or the client.

### Save, Publish, Keep

- **Save** writes your edit layers to `content/world-edits/jangan-fields/` (plus a private journal in
  `work/editor/jangan-fields/`).
- **Publish** checks the layers and builds the new map in a staging copy: it re-converts the touched regions from
  your client's archives, rebuilds the walking mesh, runs the reachability, overlap and budget checks and a set of
  tests, optimizes the changed files, and shows a report. It takes about a minute for a few regions. The first
  Publish on a new machine adds about 15 seconds to rebuild the coast cache. On a fresh clone, a Publish without new
  edits reports that nothing changed: the shipped map already holds the shipped edits.
- **Test in game** (optional) starts a private server and client on free ports that play the staging copy.
- **Keep** swaps the staged files into `work/out` and `work/out-opt`, updates the editor's base copy, and commits the
  layer folder with git (`World edits: ...`). Each Keep can be undone. **Go back** throws the staging copy away.

The same steps from a terminal: `pnpm tsx apps/viewer/editor-api/publish-cli.ts prepare|keep|discard|undo|status`, and
`pnpm sro world-edit validate|publish`.

### How a kept map reaches your server

- **Local server**: it already reads `work/out` and `work/out-opt`. Restart `pnpm server` (the world and its walking
  mesh are loaded at start) and reload the game page.
- **A server hosted with the deploy scripts** (below): the editor's **Deploy** button runs
  `pnpm run deploy -- --assets-only`, which sends only the changed asset files and restarts the server.
- **A server that runs from its own clone of this repository**: commit the changed files under `work/out`,
  `work/out-opt` and `work/editor/jangan-fields/base` (Keep commits only `content/`), push, then `git pull` on the
  server and restart it.

Do not run a full `pnpm sro convert-region --preset jangan-fields` unless you need to. It rewrites the whole live map
from your client and needs the inputs shipped under `work/` (the tree species in `work/out/trees`, the plaza models
in `work/remaster/models`).

## Optional: host the server on your own Linux machine

`deploy/` holds the scripts that run the server as a systemd user service on a Linux machine reachable over SSH,
typically over Tailscale. `pnpm run deploy` sends the committed code (`git archive HEAD`, without `work/`) and syncs
the changed files of `work/out` and `work/out-opt`; the host installs the pinned Node and pnpm and builds the client.

1. Fill in your target. The shipped values are placeholders (`YOUR_SERVER_PRIVATE_IP`, `YOUR_SSH_USER`), and the
   scripts refuse to run until they are replaced. Either set `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY` and
   `DEPLOY_BIND` as environment variables, or copy `deploy/config.local.sh.example` to `deploy/config.local.sh`
   (gitignored) and edit it.
2. `pnpm run deploy`: code and assets, then a restart and a health check. Also `-- --assets-only`, `-- --status`,
   `-- --rollback`.
3. `pnpm deploy:gm grant <username>` gives an account GM rights on the hosted server.

`docs/DEPLOY.md` covers the details: lingering, inviting friends to the tailnet, HTTPS with `tailscale serve`, and
troubleshooting. Its host names and addresses are placeholders.

## Ports

| Port | What |
|---|---|
| 7000 | Game server (`pnpm server`) |
| 5180, 5181 | Game client (`pnpm game`, and its preview) |
| 5173 | Model viewer (`pnpm viewer`; the world at `/world.html?world=jangan-fields`) |
| 5185 | World Editor (`pnpm editor`) |

## Credits

- Silkroad Online was made by Joymax. This remake is an unofficial fan project.
- The ocean and shore code contains parts ported from Tidewater (MIT licence). See
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Built with Babylon.js, Vite, better-sqlite3, sharp, meshoptimizer and the other packages in `pnpm-lock.yaml`,
  under their own licences.

# Self-updates (`pnpm serve` and the Updates page)

Anyone who clones the public repository (https://github.com/wonkyfist/Silkroad-Online-FanMade-Remake-Browser) and runs
their own server can let it follow `main`: every new commit is found, shown on the admin panel's **Updates** page with
its "What's new" entries, and (if the owner wants) installed by itself with a countdown for the players, a database
backup and an automatic rollback when the new version does not come up.

Code: `apps/server/src/updater/` (`git.ts`, `exec.ts`, `state.ts`, `schedule.ts`, `settings.ts`, `updater.ts`,
`supervisor.ts`), `apps/server/src/cli/supervise.ts`, `apps/server/src/admin/updates.ts`, `apps/admin/src/pages/updates.ts`,
`packages/shared/src/updates.ts`. Tests: `apps/server/test/updater-*.test.ts`, `admin-updates.test.ts`.

## 1. In short

```
pnpm serve ─ supervisor (plain node, no packages) ─ starts ─▶ game server (tsx src/main.ts, SRO_SUPERVISOR=1)
                                                                │ updater: every 60 min git fetch origin main
                                                                │ Updates page: what is new, Update now
                                                                │ countdown 5 min → 1 min → 10 s, backup, exit 75
           ◀──────────────────────────── exit 75 + state "handoff" ┘
  git merge --ff-only <commit> → pnpm install --frozen-lockfile → build game + admin
  → start the new server → it checks itself (/health, schema) → "healthy" → done
  (fails or no "healthy" within 180 s → git back to the old commit, install + build again,
   database backup restored only if a migration ran → old server starts, the page shows why)
```

## 2. Which installs update themselves

| Install | How it is recognised | What the Updates page does |
|---|---|---|
| **git clone of the configured repository** | `.git` at the server folder, `origin` = the configured https URL (default the public repo), branch `main` checked out | everything: checks, what's new, Update now, automatic installs, rollback |
| **git clone of something else** | `origin` missing or another URL (a fork, the developer's private repository) | **off**: shows why, never fetches |
| **ZIP download** | no `.git` | `git ls-remote` shows the latest commit and the GitHub link; explains how to switch to a clone (§7.3). No self-update: a ZIP cannot tell which version it is. |
| **release of the deploy scripts** | `.deploy-sha` (deploy/*.sh unpack `git archive` releases) | **off**: "the deploy scripts update it". This is the developer's live server; nothing there changes. |
| **any server with `AUTO_UPDATE=off`** | environment | **off** |

Default mode is **Notify only**: a fresh clone checks and shows what is new, but installs nothing until an admin presses
Update now or switches the mode to Install automatically.

## 3. Modes, checks, the window, the countdown

- **Off**: no checks. **Notify only** (default): checks every *interval* (default 60 minutes; the first a minute
  after a start) with `git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main` (HEAD never moves), and
  shows the commits and the new `content/changelog/*.md` entries read straight from the fetched commit (`git show`).
  **Install automatically**: also installs a newer commit, when all of these hold: the clone is clean, on `main` and a
  fast-forward away, the server runs under `pnpm serve`, it has been up for 5 minutes, the time is inside the install
  window (if one is set), and the commit is not the one that failed or was rolled back last (§4.4).
- **Install window** (optional): automatic installs only from *start* to *end* (`HH:MM`, may wrap midnight, e.g.
  22:00 to 06:00) in its time zone (empty = the server's). Update now ignores it.
- **Countdown**: players hear "Server update in 5 minutes …", then 1 minute and 10 seconds (notices to everyone,
  in the world and in the lobby). Nobody connected: no countdown. An admin can cancel it.
- Settings live in `DATA_DIR/updates/settings.json`; every change, check, install, cancel and rollback is an
  `updates.*` row in the audit log.

## 4. How an update runs

### 4.1 The server (updater.ts)

1. **Preconditions** (the page lists every one that fails): git clone of the configured repo, on the branch, no local
   changes to tracked files (untracked files such as `work/server` do not count), no local commits (fast-forward
   only), a check found a newer commit, `pnpm serve`, 2 GB free on the disk, no other run.
2. **Countdown** (§3), then everyone is saved and a **named database backup** is made with SQLite's online backup:
   `DATA_DIR/backups/pre-update-<time>-<from>-to-<to>.db` (the last 5 are kept). It is taken last so a restore loses
   at most the seconds before the restart. A failed backup calls the update off.
3. **Hand-over**: the state becomes `handoff` and the server saves and exits with **75** (the code the admin panel's
   Restart already uses).

### 4.2 The supervisor (supervisor.ts, `pnpm serve`)

`pnpm serve` = `node apps/server/src/cli/supervise.ts`. It runs with plain `node` (Node 24 strips the types; it
imports only `node:*` and its own files), so `pnpm install` can replace every package while it runs. It starts the
server as `node --import tsx src/main.ts` in `apps/server` with the same environment plus `SRO_SUPERVISOR=1`.

| Server exit | Supervisor |
|---|---|
| 75, no update pending | starts it again at once (the panel's Restart) |
| any code with the state at `handoff` | installs the update (below) |
| 0 | stops too (someone stopped the server) |
| anything else | a crash: starts it again after 1 s, 2 s, 5 s, 10 s, 30 s, then every 60 s (reset after a minute of uptime) |
| Ctrl+C / SIGTERM to the supervisor | the server saves and exits (killed after 20 s), no restart |

Installing (all commands and arguments are fixed in the supervisor, i.e. in the version that runs NOW, never read from
the fetched commit):

1. Checks again: origin, branch, clean tree, HEAD is still the `from` commit, the target is in the clone and a
   fast-forward. Anything wrong: the run ends as **failed**, nothing changed, the old server starts.
2. `git merge --ff-only <the checked commit>` (the exact commit the check showed, not whatever `origin/main` is now),
   with every git hook turned off (`-c core.hooksPath=<no folder>`).
3. `pnpm install --frozen-lockfile` (CI=true, no prompts), `pnpm --filter @sro/game build`, `pnpm --filter @sro/admin build`.
4. Starts the new server and waits up to 180 s for its **health self-check**: once listening, `main.ts` asks the
   updater, which checks that HEAD is the target and that its own `/health` answers `ok` with the schema it expects
   (migrations run as usual at the start), then marks the run `healthy`. The supervisor writes the history entry.

The supervisor itself keeps running the code it started with; a change to it takes effect the next time `pnpm serve`
is started (by hand or with the PC).

Why in-place (merge in the clone) rather than a staging worktree: a second worktree would need its own `node_modules`
(hundreds of MB, a full install) and its own build folders, and the swap would have to move `apps/*/dist` and
`node_modules` atomically on Windows, where open files cannot be renamed. In place, the server is down for the
install and the builds (a few minutes), and the rollback is the same three commands on the old commit.

### 4.3 Automatic rollback

A failed install or build, a new server that exits before it is healthy, or no `healthy` within the timeout: the
supervisor stops it, `git reset --keep <old commit>` (`--hard` only when that fails; the run started from a clean tree,
so only the update's own changes go), installs and builds again, and **restores the backup only if the database schema
changed** (`PRAGMA user_version` differs from before the run: a migration ran, so the old server would refuse the
database). The replaced database is kept as `DATA_DIR/backups/failed-<run>.db`. The old server starts; the page shows
the run as **rolled back** with the reason and the log.

### 4.4 Manual rollback, skipped commits

**Roll back** (History) undoes the last successful update while it is the running version: the same countdown and
backup, then `git reset` to the commit before it, install, builds; its pre-update backup is restored only if the update
changed the schema (the dialog says so: progress since the update is then lost). Automatic installs skip a commit that
failed, was rolled back automatically or rolled back by an admin; a newer commit (a fix) is installed as usual, and
Update now installs any commit.

### 4.5 State, crashes and reboots

`DATA_DIR/updates/state.json` holds the run (phase, commits, backup, log); `history.json` the last 30 runs. Both are
JSON files outside `game.db`, written atomically, so the two processes share them and a database restore never rewinds
them. Phases: `countdown → backup → handoff → merging → installing → building → starting → healthy`, or
`rolling-back`. Only one run at a time (the state file), and only one supervisor per data folder
(`supervisor.lock` with its pid; a lock of a dead process is taken over).

| Stopped during | At the next start |
|---|---|
| countdown or backup (the server's phases) | closed as **cancelled** (nothing had changed) |
| handoff, merging, installing, building | `pnpm serve` carries on (each step can run again; a merge cut in half is rolled back) |
| starting | the new server is started again and gets its health check |
| rolling-back | the rollback carries on |

Started without `pnpm serve` while a run is half-way, the page warns and nothing is touched.

## 5. The Updates page and its API

System → **Updates**: the install kind and why, warnings (Windows long paths, not under `pnpm serve`, low disk), the
running and latest commit (links to GitHub), new commits, what's new, last and next check, the settings, the run in
progress (steps, countdown, live log, Cancel), the history with each run's log, Roll back. API (admin session, every
write audited): `GET updates`, `PUT updates/settings`, `POST updates/check|install|cancel|rollback` (docs/ADMIN.md §3).

## 6. Safety

- Only an **https** URL without user name or password; `origin` must be exactly that repository (host case, a trailing
  `/` or `.git` aside). git runs with prompts off (`GIT_TERMINAL_PROMPT=0`) and a timeout on every command (fetch 30 min,
  others 1 to 10 min, install and builds 20 min).
- Nothing from the fetched commit runs before it is checked out: the check only fetches and reads files with `git show`;
  hooks are off for merge and reset; the install and build commands come from the running supervisor. After the
  checkout, `pnpm install` and the builds run the new version's lockfile and build configuration, as a manual
  `git pull && pnpm install` would.
- Fast-forward only, clean tree only: an owner's own edits and commits are never merged over or thrown away; the page
  says what is in the way.
- 2 GB free disk needed before a fetch or an install. A database backup before every run; 5 kept.
- **Windows path length**: converted assets have deep paths. Run `git config core.longpaths true` once in the clone
  (the page warns while it is off), and keep the clone near the drive root (e.g. `C:\silkroad`).

## 7. For server owners

### 7.1 Switch to `pnpm serve` (once)

Stop the server you run now (`pnpm server`, `pnpm --filter @sro/server start`, a script of your own) and start it with

```
pnpm serve
```

in the repository folder. Same environment variables as before (`PORT`, `DATA_DIR`, ...). It restarts the server when
the admin panel asks, after a crash, and for updates. To start it with the PC: Windows, a Task Scheduler task "At log
on" running `cmd /c cd /d C:\silkroad && pnpm serve`; Linux, a systemd user unit with `ExecStart=/usr/bin/env pnpm serve`
and `WorkingDirectory=` the clone (`KillMode=mixed` so the server gets SIGTERM through the supervisor); macOS, a
LaunchAgent running the same command. Then open the admin panel → Updates and pick the mode.

### 7.2 Turn it off

Mode **Off** on the page, or `AUTO_UPDATE=off` in the environment.

### 7.3 From a ZIP to a git clone

```
git clone https://github.com/wonkyfist/Silkroad-Online-FanMade-Remake-Browser.git silkroad
cd silkroad
git config core.longpaths true
pnpm install --frozen-lockfile
pnpm verify-install
```

Stop the old server, copy its `work/server` folder (the database and `DATA_DIR`; or point `DATA_DIR` at it) into the
new clone, then `pnpm serve`.

### 7.4 Fixing a failed update by hand

The page's History shows each run's log. If even the rollback failed: stop `pnpm serve`, then in the clone
`git status` (no local changes expected), `git reset --keep <the "from" commit of the run>`, `pnpm install --frozen-lockfile`,
`pnpm --filter @sro/game build`, `pnpm --filter @sro/admin build`; if the database must go back, copy the run's
`DATA_DIR/backups/pre-update-….db` over `DATA_DIR/game.db` (delete `game.db-wal` and `game.db-shm`). Delete
`DATA_DIR/updates/state.json` if a run is still listed, then `pnpm serve`.

## 8. README text (public repository)

```markdown
## Keeping your server up to date

Run your server with **`pnpm serve`** instead of `pnpm server`. It restarts the server when you press Restart in the
admin panel, after a crash, and when an update is installed.

Open the admin panel (`/admin/`) → **Updates**. Your server checks this repository every hour and shows what is new.
Choose **Install automatically** to let it update itself (optionally only at night): it backs up the database, warns
players with a 5-minute countdown, installs and builds the new version, and rolls back by itself if the new version
does not start. Or keep **Notify only** (the default) and press **Update now** when it suits you.

This needs a `git clone` of this repository (a ZIP download cannot update itself) without local changes to the
repository's files. On Windows run `git config core.longpaths true` once in the folder. Details: `docs/UPDATES.md`.
```

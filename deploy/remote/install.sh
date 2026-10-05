#!/usr/bin/env bash
# The mini PC half of deploy/deploy.sh. Uploaded to ~/silkroad/bin/ on every deploy; runs as the login
# user, never needs sudo, and only touches ~/silkroad, ~/silkroad-data, ~/silkroad-assets and
# ~/.config/systemd/user/silkroad.service.
#
#   install.sh prepare <release>    install Node/pnpm (mise), dependencies, build the game client
#   install.sh activate <release>   point ~/silkroad/current at it, restart, health-check (rolls back on failure)
#   install.sh restart              rewrite the service environment and restart
#   install.sh ensure               install/enable the service and start it if it is not running
#   install.sh rollback             switch to the previous release
#   install.sh status               what is deployed and how it runs
#
# Environment (set by deploy.sh): DEPLOY_BIND, DEPLOY_PORT, DEPLOY_KEEP_RELEASES, DEPLOY_WORLD_EXPORT.
set -euo pipefail

APP="$HOME/silkroad"
DATA="$HOME/silkroad-data"
ASSETS="$HOME/silkroad-assets"
UNIT=silkroad.service
UNIT_DIR="$HOME/.config/systemd/user"
BIND="${DEPLOY_BIND:-127.0.0.1}"
PORT="${DEPLOY_PORT:-7000}"
KEEP="${DEPLOY_KEEP_RELEASES:-3}"
WORLD_EXPORT="${DEPLOY_WORLD_EXPORT:-}"

log() { printf '    [mini-pc] %s\n' "$*"; }
die() { printf '    [mini-pc] error: %s\n' "$*" >&2; exit 1; }

# Node and pnpm exactly as the repo pins them: .npmrc use-node-version and package.json packageManager.
tool_versions() {
  local rel=$1
  NODE_V=$(sed -n 's/^use-node-version=\([0-9.]*\).*/\1/p' "$rel/.npmrc")
  PNPM_V=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$rel/package.json")
  [ -n "$NODE_V" ] || die "no use-node-version in $rel/.npmrc"
  [ -n "$PNPM_V" ] || die "no pnpm packageManager in $rel/package.json"
}

prepare() {
  local name=$1 rel="$APP/releases/$1"
  [ -d "$rel" ] || die "no release $name"
  tool_versions "$rel"
  command -v mise >/dev/null || die 'mise is not installed'
  log "mise: node@$NODE_V pnpm@$PNPM_V"
  # From $HOME, so mise does not stop at the release's (not yet trusted) mise.toml.
  if ! (cd "$HOME" && mise install "node@$NODE_V" "pnpm@$PNPM_V" > "$rel/.deploy-mise.log" 2>&1); then
    cat "$rel/.deploy-mise.log" >&2
    die 'mise install failed'
  fi
  local node_dir pnpm_dir
  node_dir=$(cd "$HOME" && mise where "node@$NODE_V")
  pnpm_dir=$(cd "$HOME" && mise where "pnpm@$PNPM_V")
  [ -x "$node_dir/bin/node" ] || die "mise has no node binary in $node_dir"
  [ -x "$pnpm_dir/pnpm" ] || die "mise has no pnpm binary in $pnpm_dir"
  cat > "$rel/.deploy-env" <<EOF
NODE_BIN=$node_dir/bin/node
PNPM_BIN=$pnpm_dir/pnpm
PATH=$node_dir/bin:$pnpm_dir:/usr/local/bin:/usr/bin:/bin
EOF
  export PATH="$node_dir/bin:$pnpm_dir:$PATH"
  cd "$rel"
  log "pnpm install --frozen-lockfile ($(node -v))"
  # Not NODE_ENV=production here: tsx (runs the server) and vite (builds the client) are devDependencies.
  if ! env -u NODE_ENV CI=1 pnpm install --frozen-lockfile --prefer-offline --reporter=append-only > "$rel/.deploy-install.log" 2>&1; then
    tail -n 40 "$rel/.deploy-install.log" >&2
    die 'pnpm install failed'
  fi
  tail -n 4 "$rel/.deploy-install.log" | sed 's/^/    [mini-pc]   /'
  log 'pnpm --filter @sro/game build'
  if ! env -u NODE_ENV CI=1 pnpm --filter @sro/game build > "$rel/.deploy-build.log" 2>&1; then
    tail -n 40 "$rel/.deploy-build.log" >&2
    die 'game client build failed'
  fi
  grep -E 'built in|dist/' "$rel/.deploy-build.log" | tail -n 4 | sed 's/^/    [mini-pc]   /' || true
  [ -f "$rel/apps/game/dist/index.html" ] || die 'the build wrote no apps/game/dist/index.html'
  # The admin panel (docs/ADMIN.md), served at /admin/. Not fatal: the game deploys without it (/admin/ then says so).
  log 'pnpm --filter @sro/admin build'
  if env -u NODE_ENV CI=1 pnpm --filter @sro/admin build > "$rel/.deploy-admin-build.log" 2>&1 && [ -f "$rel/apps/admin/dist/index.html" ]; then
    grep -E 'built in' "$rel/.deploy-admin-build.log" | tail -n 1 | sed 's/^/    [mini-pc]   /' || true
  else
    tail -n 20 "$rel/.deploy-admin-build.log" >&2 || true
    log 'WARNING: the admin panel did not build; the game deploys without it'
  fi
  log "release $name ready"
}

write_config() {
  mkdir -p "$DATA" "$ASSETS" "$UNIT_DIR"
  chmod 700 "$DATA"
  cat > "$APP/silkroad.env" <<EOF
# Written by deploy/deploy.sh on every deploy; put your own settings in silkroad.local.env.
NODE_ENV=production
HOST=$BIND
PORT=$PORT
DATA_DIR=$DATA
OUT_DIR=$ASSETS/out
OUT_OPT_DIR=$ASSETS/out-opt
GAME_DIST=$APP/current/apps/game/dist
ADMIN_DIST=$APP/current/apps/admin/dist
EOF
  # The world export (docs/DEPLOY.md "Playing on the fields"), only once its assets are here: a code deploy that
  # runs before the first asset sync leaves it to the server's default, and the restart after the sync writes it.
  if [ -n "$WORLD_EXPORT" ]; then
    if [ -f "$ASSETS/out/world/$WORLD_EXPORT/manifest.json" ]; then
      echo "WORLD_EXPORT=$WORLD_EXPORT" >> "$APP/silkroad.env"
    else
      log "world export $WORLD_EXPORT is not in $ASSETS/out/world yet; the server picks its default"
    fi
  fi
  if [ ! -f "$APP/silkroad.local.env" ]; then
    cat > "$APP/silkroad.local.env" <<'EOF'
# Your own server settings (KEY=value, see apps/server/README.md "Configuration"). They override
# silkroad.env. Apply with: systemctl --user restart silkroad
#LEVEL_CAP=20
#CAPACITY=50
#REGISTER_LIMIT=10
# The admin panel (http://<host>:7000/admin/) saves its own settings in the database; they win over these.
#REGISTRATION=open
EOF
  fi
  if ! cmp -s "$APP/bin/$UNIT" "$UNIT_DIR/$UNIT"; then
    cp "$APP/bin/$UNIT" "$UNIT_DIR/$UNIT"
    log "installed $UNIT_DIR/$UNIT"
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || systemctl --user enable "$UNIT"
}

# wait_healthy: the service answers /health on its bind address within 30 s.
wait_healthy() {
  local i
  for i in $(seq 60); do
    if curl -fsS --max-time 2 "http://$BIND:$PORT/health" >/dev/null 2>&1; then
      log "healthy: $(curl -fsS --max-time 2 "http://$BIND:$PORT/health")"
      return 0
    fi
    if ! systemctl --user is-active --quiet "$UNIT" && [ "$i" -gt 10 ]; then break; fi
    sleep 0.5
  done
  log 'the service did not become healthy; last log lines:'
  journalctl --user -u "$UNIT" -n 30 --no-pager 2>/dev/null | sed 's/^/    [mini-pc]   /' || true
  return 1
}

switch_to() {
  ln -sfn "releases/$1" "$APP/current.tmp"
  mv -Tf "$APP/current.tmp" "$APP/current"
}

current_name() { basename "$(readlink "$APP/current" 2>/dev/null || echo none)"; }

linger_note() {
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
    log "NOTE: lingering is off for $USER, so the server stops when you log out and does not start at boot."
    log "      Run once on the mini PC: sudo loginctl enable-linger $USER"
  fi
}

prune() {
  local cur keep_prev n=0 d
  cur=$(current_name)
  keep_prev=${1:-}
  for d in $(ls -1t "$APP/releases" 2>/dev/null); do
    n=$((n + 1))
    if [ "$n" -le "$KEEP" ] || [ "$d" = "$cur" ] || [ "$d" = "$keep_prev" ]; then continue; fi
    rm -rf "${APP:?}/releases/$d"
    log "removed old release $d"
  done
}

# A new release may migrate the database, so every activation first snapshots it (with the service stopped, so the
# db/-wal/-shm trio is consistent) into $DATA/backups, keeping the newest 10. A failed activation restores it.
SNAP=''
snapshot_db() {
  local f="$DATA/game.db" x old
  SNAP=''
  if [ ! -f "$f" ]; then return 0; fi
  mkdir -p "$DATA/backups"
  SNAP="$DATA/backups/game-$(date +%Y%m%d-%H%M%S)-$1.db"
  cp "$f" "$SNAP"
  for x in -wal -shm; do
    if [ -f "$f$x" ]; then cp "$f$x" "$SNAP$x"; fi
  done
  log "database snapshot: $SNAP"
  ls -1t "$DATA/backups"/game-*.db | tail -n +11 | while read -r old; do rm -f "$old" "$old-wal" "$old-shm"; done
}

restore_db() {
  local x
  if [ -z "$SNAP" ]; then return 0; fi
  rm -f "$DATA/game.db-wal" "$DATA/game.db-shm"
  cp "$SNAP" "$DATA/game.db"
  for x in -wal -shm; do
    if [ -f "$SNAP$x" ]; then cp "$SNAP$x" "$DATA/game.db$x"; fi
  done
  log "database restored from $SNAP"
}

activate() {
  local name=$1 prev
  [ -f "$APP/releases/$name/.deploy-env" ] || die "release $name was not prepared"
  prev=$(current_name)
  write_config
  systemctl --user stop "$UNIT" 2>/dev/null || true
  snapshot_db "$prev"
  switch_to "$name"
  systemctl --user restart "$UNIT"
  if wait_healthy; then
    log "live: $name (previous: $prev)"
    prune "$prev"
    linger_note
    return 0
  fi
  if [ "$prev" != none ] && [ -d "$APP/releases/$prev" ]; then
    log "rolling back to $prev"
    systemctl --user stop "$UNIT" 2>/dev/null || true
    restore_db
    switch_to "$prev"
    systemctl --user restart "$UNIT"
    wait_healthy || true
  fi
  die "release $name failed its health check"
}

restart() {
  [ -e "$APP/current" ] || die 'nothing deployed yet'
  write_config
  systemctl --user restart "$UNIT"
  wait_healthy || die 'the service is not healthy after the restart'
  linger_note
}

ensure() {
  [ -e "$APP/current" ] || die 'nothing deployed yet'
  write_config
  if ! systemctl --user is-active --quiet "$UNIT"; then systemctl --user restart "$UNIT"; fi
  wait_healthy || die 'the service is not healthy'
  linger_note
}

rollback() {
  local cur prev='' d
  cur=$(current_name)
  for d in $(ls -1t "$APP/releases"); do
    if [ -n "$prev" ]; then break; fi
    if [ "$d" != "$cur" ] && [ -f "$APP/releases/$d/.deploy-env" ] && [[ "$d" < "$cur" ]]; then prev=$d; fi
  done
  [ -n "$prev" ] || die "no release older than $cur to roll back to"
  log "rollback $cur -> $prev"
  write_config
  switch_to "$prev"
  systemctl --user restart "$UNIT"
  wait_healthy || die 'the previous release is not healthy either'
}

status() {
  log "current release: $(current_name) (commit $(cat "$APP/current/.deploy-sha" 2>/dev/null || echo '?'))"
  log "releases: $(ls -1 "$APP/releases" 2>/dev/null | tr '\n' ' ')"
  log "data: $(du -sh "$DATA" 2>/dev/null | cut -f1) in $DATA; assets: $(du -sh "$ASSETS" 2>/dev/null | cut -f1) in $ASSETS"
  systemctl --user --no-pager status "$UNIT" 2>&1 | head -n 12 | sed 's/^/    [mini-pc]   /' || true
  linger_note
}

cmd=${1:-}
shift || true
case "$cmd" in
  prepare) prepare "$@" ;;
  activate) activate "$@" ;;
  restart) restart ;;
  ensure) ensure ;;
  rollback) rollback ;;
  status) status ;;
  *) die "unknown command '$cmd'" ;;
esac

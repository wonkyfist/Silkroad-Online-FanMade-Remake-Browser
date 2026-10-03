#!/usr/bin/env bash
# Deploys the COMMITTED code (git HEAD) and the converted assets to the mini PC, then restarts the
# server there and health-checks it. Run from the repo root with Git Bash (Windows) or bash:
#
#   pnpm run deploy [-- options]      (plain `pnpm deploy` is pnpm's own built-in command)
#   bash deploy/deploy.sh [options]
#
# Options:
#   --skip-assets     code only
#   --assets-only     assets only (restarts the server when something changed)
#   --no-restart      with --assets-only: sync the assets but leave the running server alone
#   --verify-assets   re-hash the assets on the mini PC instead of trusting the stored manifest
#   --rebuild         reinstall and rebuild even if HEAD is already the deployed release
#   --rollback        switch back to the previous release and restart
#   --status          show what is deployed and whether it is healthy
#   -h, --help
#
# Target and paths: deploy/config.sh (override with env vars or deploy/config.local.sh). See docs/DEPLOY.md.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

skip_assets=0 assets_only=0 no_restart=0 verify=0 rebuild=0 action=deploy
for arg in "$@"; do
  case "$arg" in
    --skip-assets) skip_assets=1 ;;
    --assets-only) assets_only=1 ;;
    --no-restart) no_restart=1 ;;
    --verify-assets) verify=1 ;;
    --rebuild) rebuild=1 ;;
    --rollback) action=rollback ;;
    --status) action=status ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg (see --help)" ;;
  esac
done
if [ "$skip_assets$assets_only" = 11 ]; then die '--skip-assets and --assets-only exclude each other'; fi
if [ "$no_restart" = 1 ] && [ "$assets_only" = 0 ]; then die '--no-restart only goes with --assets-only (new code needs a restart)'; fi

WORK="work/.deploy"
mkdir -p "$WORK"
REMOTE_ENV="DEPLOY_BIND=$(q "$DEPLOY_BIND") DEPLOY_PORT=$(q "$DEPLOY_PORT") DEPLOY_KEEP_RELEASES=$(q "$DEPLOY_KEEP_RELEASES") DEPLOY_WORLD_EXPORT=$(q "$DEPLOY_WORLD_EXPORT")"
URL="http://$DEPLOY_HOST:$DEPLOY_PORT"

# install.sh <subcommand> [args]: the remote half (deploy/remote/install.sh, uploaded to ~/silkroad/bin).
rinstall() {
  remote "$REMOTE_ENV bash silkroad/bin/install.sh $(q "$@")"
}

upload_tooling() {
  tar -cf - -C deploy/remote . | remote 'mkdir -p silkroad/bin && tar -xf - -C silkroad/bin && chmod +x silkroad/bin/*.sh'
}

health_from_here() {
  say "health check from this PC: $URL/health"
  local body code_root code_out ok=0 i
  for i in 1 2 3 4 5; do
    if body=$(curl -fsS --max-time 5 "$URL/health" 2>/dev/null); then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || die "no answer from $URL/health (see: bash deploy/deploy.sh --status)"
  code_root=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/")
  code_out=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/out/index.json")
  echo "    /health          $body"
  echo "    /                HTTP $code_root (game client)"
  echo "    /out/index.json  HTTP $code_out (converted assets)"
  [ "$code_root" = 200 ] || warn "the game client is not being served (GAME_DIST)"
  [ "$code_out" = 200 ] || warn "the converted assets are not being served (OUT_DIR)"
}

stat_field() { sed -n "s/.*\\b$1=\\([0-9]*\\).*/\\1/p" <<<"$2"; }

# sync_tree <tree>: work/<tree> -> ~/silkroad-assets/<tree>, only files whose SHA-256 changed.
# Sets TREE_CHANGED=1 when anything was sent or removed.
sync_tree() {
  local tree=$1 src="work/$1" tw="$WORK/$1" summary files bytes changed changed_bytes deleted sent i
  TREE_CHANGED=0
  if [ ! -d "$src" ]; then
    warn "$src does not exist; skipping it"
    return
  fi
  mkdir -p "$tw"
  local dest="silkroad-assets/$tree"
  local scan="cd $dest && find . -type f ! -name .deploy-manifest -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum"
  if [ "$verify" = 1 ]; then
    remote "[ -d $dest ] || exit 0; $scan" > "$tw/remote.txt"
  else
    remote "[ -d $dest ] || exit 0; if [ -f $dest/.deploy-manifest ]; then cat $dest/.deploy-manifest; else $scan; fi" > "$tw/remote.txt"
  fi
  summary=$(pnpm exec tsx deploy/assets.ts plan --dir "$src" --remote "$tw/remote.txt" --work "$tw" --exclude "$DEPLOY_ASSET_EXCLUDE" --tree "$tree")
  files=$(stat_field files "$summary"); bytes=$(stat_field bytes "$summary")
  changed=$(stat_field changed "$summary"); changed_bytes=$(stat_field changedBytes "$summary")
  deleted=$(stat_field deleted "$summary")
  echo "    $tree: $files files, $(human "$bytes"); to send: $changed files, $(human "$changed_bytes"); to delete: $deleted"
  if [ "$changed" -gt 0 ]; then
    rm -f "$tw/sent"
    tar -cf - -C "$src" -T "$PWD/$tw/changed.txt" | gzip -1 | tee >(wc -c > "$tw/sent") \
      | remote "mkdir -p $dest && gzip -dc | tar -xf - -C $dest"
    for i in $(seq 50); do [ -s "$tw/sent" ] && break; sleep 0.1; done
    sent=$(tr -d ' \r\n' < "$tw/sent" 2>/dev/null || echo 0)
    SENT_ASSETS=$((SENT_ASSETS + ${sent:-0}))
    echo "    $tree: sent $(human "${sent:-0}") (gzip)"
    TREE_CHANGED=1
  fi
  if [ "$deleted" -gt 0 ]; then
    remote "cd $dest && xargs -r -d '\\n' rm -f -- && find . -mindepth 1 -type d -empty -delete" < "$tw/deleted.txt"
    TREE_CHANGED=1
  fi
  remote "mkdir -p $dest && cat > $dest/.deploy-manifest" < "$tw/manifest.txt"
}

check_ssh
say "target $TARGET (server $URL)"
upload_tooling

case "$action" in
  status)
    rinstall status
    health_from_here
    exit 0
    ;;
  rollback)
    rinstall rollback
    health_from_here
    exit 0
    ;;
esac

started=$(date +%s)
SENT_CODE=0 SENT_ASSETS=0 code_changed=0 assets_changed=0 release=''

if [ "$assets_only" = 0 ]; then
  sha=$(git rev-parse HEAD)
  short=${sha:0:7}
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    warn "uncommitted changes are NOT deployed; deploying HEAD $short ($(git log -1 --format=%s))"
  fi
  current=$(remote 'cat silkroad/current/.deploy-sha 2>/dev/null || true')
  if [ "$current" = "$sha" ] && [ "$rebuild" = 0 ]; then
    say "code: HEAD $short is already deployed (use --rebuild to reinstall)"
  else
    release="$(date -u +%Y%m%d-%H%M%S)-$short"
    say "code: git archive HEAD $short -> ~/silkroad/releases/$release"
    git archive --format=tar HEAD | gzip -6 > "$WORK/code.tar.gz"
    SENT_CODE=$(wc -c < "$WORK/code.tar.gz" | tr -d ' ')
    echo "    sending $(human "$SENT_CODE")"
    remote "set -e; d=silkroad/releases/$release; mkdir -p \$d; tar -xzf - -C \$d; echo $sha > \$d/.deploy-sha" < "$WORK/code.tar.gz"
    say 'code: install dependencies and build the game client on the mini PC'
    rinstall prepare "$release"
    code_changed=1
  fi
fi

if [ "$skip_assets" = 0 ]; then
  say "assets: ${DEPLOY_ASSET_TREES// /, } (excluding ${DEPLOY_ASSET_EXCLUDE//,/, })"
  for tree in $DEPLOY_ASSET_TREES; do
    sync_tree "$tree"
    if [ "$TREE_CHANGED" = 1 ]; then assets_changed=1; fi
  done
fi

if [ "$code_changed" = 1 ]; then
  say "activate $release and restart the service"
  rinstall activate "$release"
elif [ "$no_restart" = 1 ]; then
  say "--no-restart: assets synced (changed: $assets_changed); the running service was left alone"
elif [ "$assets_changed" = 1 ]; then
  say 'assets changed: restart the service'
  rinstall restart
else
  say 'nothing changed: make sure the service is installed and running'
  rinstall ensure
fi

health_from_here
say "done in $(( $(date +%s) - started ))s: sent code $(human "$SENT_CODE"), assets $(human "$SENT_ASSETS"). Play at $URL/"

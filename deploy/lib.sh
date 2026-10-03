# Shared helpers for deploy.sh and gm.sh (sourced; bash).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/config.sh
. "$REPO_ROOT/deploy/config.sh"
if [ -f "$REPO_ROOT/deploy/config.local.sh" ]; then
  # shellcheck disable=SC1091
  . "$REPO_ROOT/deploy/config.local.sh"
fi
# The public release ships placeholder targets (deploy/config.sh): refuse to run until they are set.
case " $DEPLOY_HOST $DEPLOY_USER $DEPLOY_BIND " in
  *" YOUR_"*)
    printf '\033[1;31merror:\033[0m %s\n' "set DEPLOY_HOST, DEPLOY_USER and DEPLOY_BIND (env vars or plain assignments in deploy/config.local.sh; see deploy/config.sh and README.md)" >&2
    exit 1 ;;
esac

DEPLOY_KEY="${DEPLOY_KEY/#\~/$HOME}"
SSH_OPTS=(-i "$DEPLOY_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

# remote <command string>: runs on the mini PC in the login user's home directory.
remote() {
  ssh "${SSH_OPTS[@]}" "$TARGET" "$@"
}

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# human <bytes>
human() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# q <args...>: each argument shell-quoted for the remote command line.
q() {
  local out='' a
  for a in "$@"; do out+=" $(printf '%q' "$a")"; done
  printf '%s' "${out# }"
}

check_ssh() {
  [ -f "$DEPLOY_KEY" ] || die "SSH key $DEPLOY_KEY not found (set DEPLOY_KEY)"
  remote true || die "cannot reach $TARGET over SSH (is Tailscale up on both machines?)"
}

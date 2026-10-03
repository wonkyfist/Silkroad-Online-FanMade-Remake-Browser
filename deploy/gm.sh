#!/usr/bin/env bash
# Runs the owner GM CLI on the mini PC's server database over SSH.
#
#   pnpm deploy:gm grant <username> [--role gm|admin]
#   pnpm deploy:gm revoke <username>
#   pnpm deploy:gm list
#   pnpm deploy:gm audit [--limit N]
#
# Safe while the server runs; a connected player gets the new role within about a second.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ $# = 0 ]; then
  sed -n '4,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
check_ssh
remote "test -x silkroad/bin/gm.sh && test -e silkroad/current" || die 'nothing deployed on the mini PC yet: run pnpm run deploy first'
remote "silkroad/bin/gm.sh $(q "$@")"

#!/usr/bin/env bash
# The owner GM CLI (apps/server/src/cli/gm.ts, same as `pnpm gm`) on the deployed server's database.
#   ~/silkroad/bin/gm.sh grant <username> [--role gm|admin] | revoke <username> | list | audit [--limit N]
set -euo pipefail
REL=$(readlink -f "$HOME/silkroad/current")
set -a
# shellcheck disable=SC1091
. "$HOME/silkroad/silkroad.env"
# shellcheck disable=SC1091
if [ -f "$HOME/silkroad/silkroad.local.env" ]; then . "$HOME/silkroad/silkroad.local.env"; fi
set +a
# shellcheck disable=SC1091
. "$REL/.deploy-env"
export PATH
cd "$REL/apps/server"
exec "$NODE_BIN" --import tsx src/cli/gm.ts "$@"
